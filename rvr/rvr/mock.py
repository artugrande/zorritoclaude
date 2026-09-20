"""A simulated rover, so the whole stack runs with no hardware attached.

This exists because "it compiles" is not evidence that a robot control system
works. The mock speaks the same wire protocol, drifts the way a chassis with no
encoders actually drifts, and renders a navigable little world through a
raycaster — so the agent loop, the reflex layer, takeover and the map can all be
exercised end to end before anyone charges a battery.

It is a sandbox, not a simulator: no real dynamics, no wheel slip model, no
lighting. Things that worked here still need checking on the real rover. What it
does buy is that everything *above* the transport layer has been run.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import math
import random
import time

from . import protocol as p
from .transport import LinkStatus

log = logging.getLogger(__name__)

# One grid cell is half a metre.
CELL_M = 0.5
FULL_SPEED_MS = 0.35       # metres/second at power 100
FULL_TURN_DEG = 130.0      # degrees/second at power 100 spinning in place
DRIFT_PER_SEC = 2.5        # degrees of heading error, the cost of no encoders

WORLD = [
    "################",
    "#....C.........#",
    "#....####......#",
    "#..............#",
    "#..##....##....#",
    "#..##....##..T.#",
    "#..............#",
    "#......B.......#",
    "#..............#",
    "####....########",
    "#..............#",
    "#.P..........S.#",
    "#..............#",
    "#......##......#",
    "#......##......#",
    "################",
]

# Cell -> (r, g, b). Landmarks are strongly coloured so a vision model has
# something unambiguous to navigate by.
COLORS = {
    "#": (118, 110, 102),
    "C": (198, 72, 60),     # red cabinet
    "T": (70, 130, 190),    # blue table
    "B": (210, 170, 70),    # yellow box
    "P": (90, 170, 110),    # green plant
    "S": (170, 100, 190),   # purple shelf
}
LANDMARKS = {
    "C": "a red cabinet", "T": "a blue table", "B": "a yellow box",
    "P": "a green plant", "S": "a purple shelf",
}

WIDTH, HEIGHT = 320, 240
FOV = math.radians(62)
MAX_RANGE_CELLS = 14.0


class MockWorld:
    """Pose, physics and rendering for the simulated rover."""

    def __init__(self, x: float = 5.5, y: float = 11.5, heading: float = 0.0) -> None:
        if WORLD[int(y)][int(x)] != ".":
            raise ValueError(
                f"start pose ({x}, {y}) is inside cell "
                f"{WORLD[int(y)][int(x)]!r}; every ray would hit at zero range"
            )
        self.x, self.y = x, y
        self.heading = heading  # radians, 0 = +x
        self.left = 0
        self.right = 0
        self.battery_v = 8.1
        self.tilt = p.SERVO_CENTER
        self.lamp = False
        self.rgb = (0, 0, 0)
        self._last_step = time.monotonic()

    # --- physics -------------------------------------------------------------

    def step(self) -> None:
        now = time.monotonic()
        dt = min(now - self._last_step, 0.2)
        self._last_step = now
        if dt <= 0:
            return

        forward = (self.left + self.right) / 200.0
        turn = (self.right - self.left) / 200.0

        if forward or turn:
            self.heading += math.radians(turn * FULL_TURN_DEG) * dt
            # No encoders, so heading error accumulates whenever we move. This
            # is the single most important thing the mock reproduces.
            self.heading += math.radians(random.gauss(0, DRIFT_PER_SEC)) * dt
            distance = forward * FULL_SPEED_MS * dt / CELL_M
            nx = self.x + math.cos(self.heading) * distance
            ny = self.y + math.sin(self.heading) * distance
            if not self._solid(nx, self.y):
                self.x = nx
            if not self._solid(self.x, ny):
                self.y = ny
            self.battery_v -= 0.00025 * dt * (abs(forward) + abs(turn))
        else:
            self.battery_v -= 0.00002 * dt
        self.battery_v = max(6.0, self.battery_v)

    def _cell(self, x: float, y: float) -> str:
        ix, iy = int(x), int(y)
        if 0 <= iy < len(WORLD) and 0 <= ix < len(WORLD[iy]):
            return WORLD[iy][ix]
        return "#"

    def _solid(self, x: float, y: float) -> bool:
        return self._cell(x, y) != "."

    # --- sensing -------------------------------------------------------------

    def _cast(self, angle: float) -> tuple[float, str]:
        """March a ray; return distance in cells and the cell hit."""
        dx, dy = math.cos(angle), math.sin(angle)
        distance = 0.0
        while distance < MAX_RANGE_CELLS:
            distance += 0.02
            cell = self._cell(self.x + dx * distance, self.y + dy * distance)
            if cell != ".":
                return distance, cell
        return MAX_RANGE_CELLS, "."

    def telemetry(self) -> p.Telemetry:
        ahead, _ = self._cast(self.heading)
        distance_cm = ahead * CELL_M * 100.0
        left, _ = self._cast(self.heading - math.radians(24))
        right, _ = self._cast(self.heading + math.radians(24))
        ir_threshold = 0.45 / CELL_M  # the real IR sensors reach ~45cm
        return p.Telemetry(
            distance_cm=None if distance_cm > 300 else round(distance_cm + random.gauss(0, 1.2), 1),
            ir_left=left < ir_threshold,
            ir_right=right < ir_threshold,
            battery_v=round(self.battery_v, 2),
        )

    def visible_landmarks(self) -> list[str]:
        """Debug aid: what the agent ought to be able to see from here."""
        seen = set()
        for step in range(-10, 11):
            _, cell = self._cast(self.heading + step * FOV / 20)
            if cell in LANDMARKS:
                seen.add(LANDMARKS[cell])
        return sorted(seen)

    # --- rendering -----------------------------------------------------------

    def render(self) -> bytes:
        from PIL import Image, ImageDraw

        image = Image.new("RGB", (WIDTH, HEIGHT), (30, 30, 34))
        draw = ImageDraw.Draw(image)
        # Tilt shifts the horizon: 90 is level, higher looks up.
        horizon = HEIGHT // 2 + int((self.tilt - p.SERVO_CENTER) * 1.3)
        draw.rectangle([0, 0, WIDTH, horizon], fill=(56, 58, 66))          # ceiling
        draw.rectangle([0, horizon, WIDTH, HEIGHT], fill=(96, 88, 78))     # floor

        for column in range(WIDTH):
            angle = self.heading - FOV / 2 + FOV * column / WIDTH
            distance, cell = self._cast(angle)
            if cell == ".":
                continue
            # Correct for the fisheye a flat projection plane would otherwise show.
            corrected = max(0.15, distance * math.cos(angle - self.heading))
            height = min(HEIGHT, int(HEIGHT / corrected * 0.62))
            shade = max(0.18, min(1.0, 1.25 / (1.0 + corrected * 0.45)))
            if self.lamp:
                shade = min(1.0, shade * 1.5)
            r, g, b = COLORS.get(cell, (120, 120, 120))
            top = horizon - height // 2
            draw.rectangle(
                [column, top, column, top + height],
                fill=(int(r * shade), int(g * shade), int(b * shade)),
            )

        if self.rgb != (0, 0, 0):  # the chassis strip glowing on the floor
            draw.rectangle([0, HEIGHT - 6, WIDTH, HEIGHT], fill=self.rgb)

        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=70)
        return buffer.getvalue()


class MockRoverLink:
    """Stands in for :class:`~rvr.transport.RoverLink`, speaking real frames."""

    def __init__(self, world: MockWorld, *, telemetry_hz: float = 20.0) -> None:
        self.world = world
        self.telemetry_hz = telemetry_hz
        self.on_telemetry = None
        self.status = LinkStatus(connected=True, connected_since=time.time(), info={"Name": "MockRVR"})
        self.host = "mock"
        self.port = p.WS_PORT
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.sent_frames = 0

    @property
    def connected(self) -> bool:
        return True

    @property
    def url(self) -> str:
        return "mock://rover"

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="mock-rover")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def send(self, payload: bytes) -> bool:
        """Decode a real command frame, exactly as the firmware would."""
        self.sent_frames += 1
        # Round-trip through the codec so a framing bug shows up here too.
        payload = p.decode_frame(p.encode_frame(payload), strict=True)
        i = 0
        while i < len(payload):
            tag = payload[i]
            if tag == p.CMD_MOTORS and i + 2 < len(payload):
                self.world.left = int.from_bytes(payload[i + 1 : i + 2], "big", signed=True)
                self.world.right = int.from_bytes(payload[i + 2 : i + 3], "big", signed=True)
                i += 3
            elif tag == p.CMD_RGB and i + 3 < len(payload):
                self.world.rgb = (payload[i + 1], payload[i + 2], payload[i + 3])
                i += 4
            elif tag == p.CMD_SERVO and i + 1 < len(payload):
                self.world.tilt = payload[i + 1]
                i += 2
            elif tag == p.CMD_LAMP and i + 1 < len(payload):
                self.world.lamp = bool(payload[i + 1])
                i += 2
            elif tag == p.CMD_OBSTACLE_MODE and i + 3 < len(payload):
                i += 4
            else:
                i += 1
        return True

    async def _run(self) -> None:
        period = 1.0 / self.telemetry_hz
        while not self._stop.is_set():
            self.world.step()
            if self.on_telemetry is not None:
                self.on_telemetry(self.world.telemetry())
            await asyncio.sleep(period)


class MockCameraLink:
    """Stands in for :class:`~rvr.transport.CameraLink`."""

    def __init__(self, world: MockWorld, *, fps_target: float = 10.0) -> None:
        self.world = world
        self.fps_target = fps_target
        self.status = LinkStatus(connected=True, connected_since=time.time())
        self.host = "mock"
        self.port = p.CAMERA_PORT
        self._frame: bytes | None = None
        self._frame_time = 0.0
        self._new_frame = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    @property
    def stream_url(self) -> str:
        return "mock://camera"

    @property
    def fps(self) -> float:
        return self.fps_target

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="mock-camera")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def latest(self) -> tuple[bytes | None, float]:
        return self._frame, self._frame_time

    async def wait_for_fresh(self, newer_than: float, timeout: float = 4.0) -> bytes | None:
        deadline = time.monotonic() + timeout
        while self._frame_time <= newer_than:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return self._frame
            self._new_frame.clear()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._new_frame.wait(), timeout=remaining)
        return self._frame

    async def capture(self) -> bytes | None:
        return self._frame

    async def _run(self) -> None:
        period = 1.0 / self.fps_target
        loop = asyncio.get_running_loop()
        while not self._stop.is_set():
            # Rendering is pure CPU; keep it off the control loop's thread.
            self._frame = await loop.run_in_executor(None, self.world.render)
            self._frame_time = time.time()
            self._new_frame.set()
            await asyncio.sleep(period)


def build_mock() -> tuple[MockWorld, MockRoverLink, MockCameraLink]:
    world = MockWorld()
    return world, MockRoverLink(world), MockCameraLink(world)
