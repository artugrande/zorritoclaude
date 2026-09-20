"""High-level rover control, with the reflex layer that keeps it intact.

Claude thinks at roughly 1 Hz. That is fine for deciding *where to go* and
useless for *not hitting the wall*, so this module runs a 10 Hz loop between
the two: every tick it re-derives motor power from the current motion target,
clamps it against live telemetry, and resends it.

Resending is not redundant. The ESP32 emits ``[APPSTOP]`` after 3 seconds
without data, so a held motion has to be refreshed anyway -- and making the
refresh the *only* path to the motors means a crashed brain, a dropped socket
or a cancelled task all coast to a stop instead of leaving the rover driving.

The on-board firmware has its own avoidance mode, but sending any motor command
forces ``MODE_APP_CONTROL`` and switches it off. While we drive, obstacle
safety is ours.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field

from . import protocol as p
from .transport import CameraLink, RoverLink

log = logging.getLogger(__name__)


@dataclass
class SafetyLimits:
    stop_distance_cm: float = 18.0
    """Below this, forward motion is refused outright."""

    slow_distance_cm: float = 40.0
    """Between stop and slow, forward power is scaled down linearly."""

    creep_speed: int = 35
    """Speed cap when telemetry is stale -- driving blind, so drive slowly."""

    telemetry_stale_s: float = 2.0
    max_drive_ms: int = 3000
    """No single command may hold the motors longer than this."""

    battery_min_v: float = 6.4
    """Under load a healthy pack sags; below this, refuse to drive at all."""

    command_hz: float = 10.0
    min_effective_power: int = 20
    """carSetMotors maps |power| onto PWM 28..255; under ~20 it just buzzes."""


@dataclass
class MotionTarget:
    left: int = 0
    right: int = 0
    expires_at: float = 0.0
    source: str = "none"

    @property
    def active(self) -> bool:
        # bool() matters: `x and (a or b)` yields the int, and this value is
        # exposed as `moving` in the state JSON the UI reads.
        return bool(time.monotonic() < self.expires_at and (self.left or self.right))


@dataclass
class DriveResult:
    """What actually happened -- not what was asked for.

    The agent reads this back as a tool result, so it has to be honest: a drive
    that was vetoed by the reflex layer must not look like a drive that worked,
    or Claude will build its whole world model on motions that never happened.
    """

    requested: tuple[int, int]
    applied: tuple[int, int]
    duration_ms: int
    vetoed: bool = False
    reason: str | None = None
    telemetry: p.Telemetry = field(default_factory=p.Telemetry)

    def describe(self) -> str:
        if self.vetoed:
            return f"Motion refused: {self.reason}. The rover did not move."
        note = f" ({self.reason})" if self.reason else ""
        return (
            f"Drove motors L={self.applied[0]} R={self.applied[1]} "
            f"for {self.duration_ms}ms{note}. Now: {self.telemetry.describe()}"
        )


class Rover:
    """Everything above the wire: motion, sensors, camera, safety."""

    def __init__(
        self,
        link: RoverLink,
        camera: CameraLink,
        limits: SafetyLimits | None = None,
    ) -> None:
        self.link = link
        self.camera = camera
        self.limits = limits or SafetyLimits()

        self.telemetry = p.Telemetry()
        self._telemetry_at: float = 0.0
        self._target = MotionTarget()
        self._last_sent: tuple[int, int] | None = None
        self._loop_task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._tilt = p.SERVO_CENTER
        self._lamp = False
        self._last_veto: str | None = None

        link.on_telemetry = self._on_telemetry

    # --- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        self._stop.clear()
        await self.link.start()
        await self.camera.start()
        self._loop_task = asyncio.create_task(self._motion_loop(), name="motion-loop")

    async def stop(self) -> None:
        self._stop.set()
        self.halt("shutdown")
        with contextlib.suppress(Exception):
            await self.link.send(p.cmd_motors(0, 0))
        if self._loop_task is not None:
            self._loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop_task
        await self.camera.stop()
        await self.link.stop()

    # --- telemetry -----------------------------------------------------------

    def _on_telemetry(self, telemetry: p.Telemetry) -> None:
        # Packets can carry a subset of sensors; keep the last known value for
        # anything this one omits rather than flapping fields to None.
        self.telemetry = telemetry.merged_with(self.telemetry)
        self._telemetry_at = time.monotonic()

    @property
    def telemetry_fresh(self) -> bool:
        return (time.monotonic() - self._telemetry_at) < self.limits.telemetry_stale_s

    @property
    def moving(self) -> bool:
        return self._target.active

    def state(self) -> dict:
        return {
            "connected": self.link.connected,
            "camera": self.camera.status.connected,
            "fps": self.camera.fps,
            "moving": self.moving,
            "motors": {"left": self._target.left, "right": self._target.right}
            if self.moving
            else {"left": 0, "right": 0},
            "motion_source": self._target.source if self.moving else None,
            "tilt": self._tilt,
            "lamp": self._lamp,
            "telemetry_fresh": self.telemetry_fresh,
            "last_veto": self._last_veto,
            "distance_cm": self.telemetry.distance_cm,
            "ir_left": self.telemetry.ir_left,
            "ir_right": self.telemetry.ir_right,
            "battery_v": self.telemetry.battery_v,
            "battery_pct": self.telemetry.battery_pct,
        }

    # --- the reflex loop -----------------------------------------------------

    async def _motion_loop(self) -> None:
        period = 1.0 / self.limits.command_hz
        while not self._stop.is_set():
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("motion tick failed")
            await asyncio.sleep(period)

    async def _tick(self) -> None:
        if self._target.active:
            left, right, reason = self._clamp(self._target.left, self._target.right)
        else:
            left, right, reason = 0, 0, None
        self._last_veto = reason

        # Zeros are resent for a few ticks after motion ends, then we go quiet.
        # A held stop is worth repeating -- a dropped stop packet is the one
        # packet loss that actually hurts.
        if (left, right) == (0, 0) and self._last_sent == (0, 0):
            return
        if await self.link.send(p.cmd_motors(left, right)):
            self._last_sent = (left, right)

    def _clamp(self, left: int, right: int) -> tuple[int, int, str | None]:
        """Apply the reflex rules. Returns the safe motor pair and a reason.

        Forward motion is the only thing gated. Reversing and turning in place
        stay available even with an obstacle right in front -- otherwise the
        rover gates itself into a corner it cannot drive out of.
        """
        limits = self.limits
        telemetry = self.telemetry

        if telemetry.battery_v is not None and telemetry.battery_v < limits.battery_min_v:
            return 0, 0, f"battery critically low ({telemetry.battery_v:.2f}V)"

        forward = (left + right) / 2.0
        if forward <= 0:
            return left, right, None  # reversing or spinning: always allowed

        if not self.telemetry_fresh:
            scale = min(1.0, limits.creep_speed / max(abs(left), abs(right), 1))
            if scale < 1.0:
                return (
                    int(left * scale),
                    int(right * scale),
                    "telemetry stale, creeping",
                )
            return left, right, None

        if telemetry.ir_left or telemetry.ir_right:
            side = "left" if telemetry.ir_left else "right"
            if telemetry.ir_left and telemetry.ir_right:
                side = "both sides"
            return 0, 0, f"IR obstacle detected on {side}"

        distance = telemetry.distance_cm
        if distance is not None:
            if distance < limits.stop_distance_cm:
                return 0, 0, f"obstacle {distance:.0f}cm ahead"
            if distance < limits.slow_distance_cm:
                span = limits.slow_distance_cm - limits.stop_distance_cm
                scale = (distance - limits.stop_distance_cm) / span
                scaled_l, scaled_r = int(left * scale), int(right * scale)
                # Scaling below the motor's dead band stalls it without saying
                # so; treat that as a stop, which is at least truthful.
                if max(abs(scaled_l), abs(scaled_r)) < limits.min_effective_power:
                    return 0, 0, f"too close to proceed ({distance:.0f}cm)"
                return scaled_l, scaled_r, f"slowing, {distance:.0f}cm ahead"

        return left, right, None

    # --- motion commands -----------------------------------------------------

    def halt(self, source: str = "stop") -> None:
        """Drop the motion target immediately. The next tick sends zeros.

        Synchronous on purpose: a takeover or an emergency stop must not wait
        on the event loop to schedule a coroutine.
        """
        self._target = MotionTarget(0, 0, 0.0, source)

    async def drive(
        self,
        left: int,
        right: int,
        duration_ms: int,
        *,
        source: str = "agent",
        hold: bool = False,
    ) -> DriveResult:
        """Drive the motors for a bounded time, then stop.

        With ``hold=True`` the target is set and we return immediately -- that is
        what manual driving wants, where the next keystroke or a key release
        supersedes this one. The agent always uses the awaited form so its tool
        result describes a motion that has already finished.
        """
        duration_ms = max(0, min(int(duration_ms), self.limits.max_drive_ms))
        requested = (int(left), int(right))

        if not self.link.connected:
            return DriveResult(requested, (0, 0), 0, True, "rover link is down", self.telemetry)

        applied_l, applied_r, reason = self._clamp(*requested)
        if (applied_l, applied_r) == (0, 0) and requested != (0, 0):
            self.halt(source)
            return DriveResult(requested, (0, 0), 0, True, reason, self.telemetry)

        self._target = MotionTarget(
            requested[0], requested[1], time.monotonic() + duration_ms / 1000.0, source
        )
        if hold:
            return DriveResult(requested, (applied_l, applied_r), duration_ms, telemetry=self.telemetry)

        try:
            await asyncio.sleep(duration_ms / 1000.0)
        except asyncio.CancelledError:
            # A takeover cancelled us mid-drive. Stop before propagating, or the
            # rover keeps rolling until the target expires on its own.
            self.halt("cancelled")
            raise
        finally:
            if self._target.source == source:
                self.halt(source)

        return DriveResult(
            requested, (applied_l, applied_r), duration_ms, reason=self._last_veto or reason,
            telemetry=self.telemetry,
        )

    async def forward(self, speed: int = 55, duration_ms: int = 800, **kw) -> DriveResult:
        return await self.drive(speed, speed, duration_ms, **kw)

    async def backward(self, speed: int = 55, duration_ms: int = 800, **kw) -> DriveResult:
        return await self.drive(-speed, -speed, duration_ms, **kw)

    async def turn_left(self, speed: int = 55, duration_ms: int = 450, **kw) -> DriveResult:
        return await self.drive(-speed, speed, duration_ms, **kw)

    async def turn_right(self, speed: int = 55, duration_ms: int = 450, **kw) -> DriveResult:
        return await self.drive(speed, -speed, duration_ms, **kw)

    # --- accessories ---------------------------------------------------------

    async def tilt(self, angle: int) -> int:
        """Tilt the camera. There is only this one axis -- panning means turning."""
        self._tilt = max(p.SERVO_MIN, min(p.SERVO_MAX, int(angle)))
        await self.link.send(p.cmd_servo(self._tilt))
        await asyncio.sleep(0.4)  # let the servo actually arrive before anyone photographs
        return self._tilt

    async def set_leds(self, r: int, g: int, b: int) -> None:
        await self.link.send(p.cmd_rgb(r, g, b))

    async def set_lamp(self, on: bool) -> None:
        self._lamp = bool(on)
        await self.link.send(p.cmd_lamp(on))

    async def release_onboard_autonomy(self) -> None:
        """Make sure the firmware's own avoidance/following mode is off."""
        await self.link.send(p.cmd_obstacle_mode(False))

    # --- perception ----------------------------------------------------------

    async def snapshot(self, *, fresh: bool = True, settle_ms: int = 250) -> bytes | None:
        """Grab a frame, by default one captured after this call started.

        ``settle_ms`` covers motion blur: the chassis is still rocking right
        after the motors cut, and a smeared frame is worse than a late one.
        """
        if settle_ms:
            await asyncio.sleep(settle_ms / 1000.0)
        if not fresh:
            return self.camera.latest()[0]
        frame = await self.camera.wait_for_fresh(time.time())
        if frame is None:
            frame = await self.camera.capture()  # stream down; try the one-shot
        return frame

    async def scan(self, steps: int = 6, speed: int = 50, step_ms: int = 380) -> list[bytes]:
        """Rotate in place, photographing each step. Roughly a panorama.

        Steps are open-loop -- there is no compass or wheel encoder on this
        chassis -- so treat the result as "views around here", never as
        calibrated bearings.
        """
        frames: list[bytes] = []
        for index in range(steps):
            frame = await self.snapshot()
            if frame is not None:
                frames.append(frame)
            if index < steps - 1:
                await self.turn_right(speed, step_ms, source="scan")
                await asyncio.sleep(0.25)  # settle
        return frames
