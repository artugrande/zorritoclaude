"""Who is driving, right now.

Three parties want the motors: the reflex layer, the operator, and the agent.
They are strictly ranked — SAFETY > MANUAL > AGENT — and this module enforces
the bottom two. Safety enforces itself, unconditionally, inside
:class:`~rvr.rover.Rover`; nothing here can talk it out of a veto.

The interesting case is the middle one. Grabbing the controls during an
autonomous run must not require asking permission, waiting for a tool call to
finish, or aborting the mission: the operator moves the rover, the agent is
paused mid-action, and when control goes back the agent is told it was moved and
shown where it ended up. That is what makes manual and autonomous the same
system rather than two programs fighting over a serial port.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import time
from enum import Enum

import anthropic

from .agent import AgentSession
from .events import EventBus
from .intent import Intent, IntentRouter
from .llm import LLMConfig
from .mission import MissionLog
from .rover import Rover
from .semantic_map import Move, SemanticMap
from .tools import ToolContext

log = logging.getLogger(__name__)

class Mode(str, Enum):
    MANUAL = "manual"
    """The operator drives. Any running agent is paused."""

    AUTO = "auto"
    """The agent drives. Operator input preempts it."""

    TEACH = "teach"
    """The operator drives and narrates; moves are recorded into the map."""


class Arbiter:
    def __init__(
        self,
        rover: Rover,
        smap: SemanticMap,
        missions: MissionLog,
        bus: EventBus,
        *,
        llm: LLMConfig | None = None,
    ) -> None:
        self.rover = rover
        self.smap = smap
        self.missions = missions
        self.bus = bus
        self.llm = llm or LLMConfig()

        self.mode = Mode.MANUAL
        self.router = IntentRouter(self.llm)
        self._client = self.llm.client()

        self.ctx = ToolContext(rover=rover, smap=smap, missions=missions, bus=bus)
        self.agent: AgentSession | None = None
        self._agent_task: asyncio.Task | None = None
        self._teach_moves: list[Move] = []
        self._last_manual_at: float = 0.0

    # --- state ---------------------------------------------------------------

    @property
    def agent_running(self) -> bool:
        return self._agent_task is not None and not self._agent_task.done()

    def state(self) -> dict:
        return {
            "mode": self.mode.value,
            "rover": self.rover.state(),
            "agent": self.agent.state.as_dict() if self.agent else None,
            "agent_running": self.agent_running,
            "teach_moves": len(self._teach_moves),
            "places": len(self.smap.places),
            "mission": self.missions.current.as_dict() if self.missions.current else None,
        }

    # --- mode ----------------------------------------------------------------

    async def set_mode(self, mode: Mode | str, reason: str = "operator") -> dict:
        mode = Mode(mode)
        if mode == self.mode:
            return self.state()
        previous, self.mode = self.mode, mode
        log.info("mode %s -> %s (%s)", previous.value, mode.value, reason)

        if mode in (Mode.MANUAL, Mode.TEACH):
            self.rover.halt("mode change")
            if self.agent is not None and self.agent.state.running:
                self.agent.interrupt(f"operator switched to {mode.value} mode")
        elif mode == Mode.AUTO:
            self.rover.halt("mode change")
            if self.agent is not None and self.agent.state.paused:
                self.agent.resume(self._takeover_note())
            elif not self.agent_running:
                self.bus.publish(
                    "mission",
                    text="Auto mode is armed, but there is no mission. Give it a goal.",
                )

        if previous == Mode.TEACH and mode != Mode.TEACH:
            self._teach_moves.clear()

        self.bus.publish("mode", mode=mode.value, previous=previous.value, reason=reason)
        return self.state()

    def _takeover_note(self) -> str:
        if not self._last_manual_at:
            return "You were paused."
        seconds = time.time() - self._last_manual_at
        return (
            f"The operator drove the rover manually, finishing about {seconds:.0f} "
            "seconds ago. It may be somewhere entirely different now."
        )

    # --- manual control ------------------------------------------------------

    async def manual_motors(
        self, left: int, right: int, duration_ms: int = 400, *, hold: bool = True
    ) -> dict:
        """Operator-issued motion. Preempts the agent without being asked twice.

        ``hold=True`` (the default) returns as soon as the motion is armed, so a
        stream of keyboard or joystick events stays responsive; each new command
        supersedes the previous one.
        """
        self._takeover_if_needed()
        self._last_manual_at = time.time()

        result = await self.rover.drive(left, right, duration_ms, source="manual", hold=hold)
        if self.mode == Mode.TEACH and not result.vetoed:
            self._teach_moves.append(Move(left, right, duration_ms))
            del self._teach_moves[:-200]

        self.bus.publish("drive", source="manual", left=left, right=right, result=result.describe())
        return {"ok": not result.vetoed, "detail": result.describe()}

    async def manual_direction(self, direction: str, speed: int = 55, duration_ms: int = 500) -> dict:
        vectors = {
            "forward": (speed, speed),
            "backward": (-speed, -speed),
            "left": (-speed, speed),
            "right": (speed, -speed),
            "stop": (0, 0),
        }
        if direction not in vectors:
            return {"ok": False, "detail": f"unknown direction {direction!r}"}
        if direction == "stop":
            self.emergency_stop("operator")
            return {"ok": True, "detail": "Stopped."}
        left, right = vectors[direction]
        return await self.manual_motors(left, right, duration_ms)

    def emergency_stop(self, reason: str = "operator") -> None:
        """Cut motion now. Synchronous, and safe to call from anywhere.

        Deliberately does not await: the stop must land on the next 10 Hz tick
        regardless of what the event loop is busy with.
        """
        was_moving = self.rover.moving
        was_auto = self.mode == Mode.AUTO
        self.rover.halt(reason)
        # _takeover_if_needed emits the takeover event when one actually happens.
        # Announcing a takeover on every key release, with no agent to take over
        # from, trains the operator to ignore the one that matters.
        self._takeover_if_needed(reason=f"emergency stop ({reason})")
        if not was_auto and was_moving:
            self.bus.publish("log", text=f"Stopped ({reason})")

    def _takeover_if_needed(self, reason: str = "operator took the controls") -> None:
        if self.mode != Mode.AUTO:
            return
        self.mode = Mode.MANUAL
        if self.agent is not None and self.agent.state.running:
            self.agent.interrupt(reason)
        log.info("takeover: %s", reason)
        self.bus.publish("takeover", reason=reason, trigger="manual", mode=self.mode.value)
        self.bus.publish("mode", mode=self.mode.value, previous=Mode.AUTO.value, reason=reason)

    # --- autonomy ------------------------------------------------------------

    async def start_mission(self, goal: str) -> dict:
        if self.agent_running:
            await self.abort_mission("superseded by a new mission")

        await self.rover.release_onboard_autonomy()
        self.agent = AgentSession(self.ctx, llm=self.llm)
        self.mode = Mode.AUTO
        self.bus.publish("mode", mode=self.mode.value, reason="mission started")
        self._agent_task = asyncio.create_task(self.agent.run(goal), name="agent-mission")

        def _done(task: asyncio.Task) -> None:
            self.rover.halt("mission ended")
            if self.mode == Mode.AUTO:
                self.mode = Mode.MANUAL
                self.bus.publish("mode", mode=self.mode.value, reason="mission ended")
            if not task.cancelled() and task.exception() is not None:
                log.error("mission task failed", exc_info=task.exception())

        self._agent_task.add_done_callback(_done)
        return self.state()

    async def abort_mission(self, reason: str = "operator") -> dict:
        self.rover.halt("mission aborted")
        if self._agent_task is not None and not self._agent_task.done():
            self._agent_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._agent_task
        self._agent_task = None
        self.agent = None
        if self.mode == Mode.AUTO:
            self.mode = Mode.MANUAL
        self.bus.publish("mission", text=f"Mission aborted ({reason})")
        self.bus.publish("mode", mode=self.mode.value, reason="mission aborted")
        return self.state()

    # --- teaching ------------------------------------------------------------

    async def teach_place(self, name: str, description: str = "", *, scan: bool = True) -> dict:
        """Name wherever the rover is standing right now.

        With no description given, Claude looks through the camera and writes
        one. That is the point of teaching by demonstration: you drive and say
        "this is the kitchen", and the description that makes the place
        recognisable later is written from what the rover can actually see,
        not from what you remembered to type.
        """
        name = (name or "").strip()
        if not name:
            return {"ok": False, "detail": "A place needs a name."}

        self.rover.halt("teaching")
        frames = await self.rover.scan(steps=4) if scan else []
        if not frames:
            frame = await self.rover.snapshot()
            frames = [frame] if frame else []
        if not frames:
            return {"ok": False, "detail": "No camera frames — cannot learn this place."}

        if not description:
            description = await self._describe_scene(frames, name)

        place = self.smap.learn(
            name, frames, description=description, approach=list(self._teach_moves)
        )
        self._teach_moves.clear()
        self.bus.publish(
            "place", name=place.name, description=place.description, id=place.id,
            keyframes=len(place.keyframes),
        )
        log.info("taught place %r (%d keyframes)", place.name, len(place.keyframes))
        return {"ok": True, "detail": f'Learned "{place.name}".', "description": place.description}

    async def _describe_scene(self, frames: list[bytes], name: str) -> str:
        """Ask Claude what this place looks like, for later recognition."""
        if self._client is None:
            return ""

        content: list[dict] = [
            {
                "type": "text",
                "text": (
                    f'A robot with a floor-level camera is being taught that this location is '
                    f'called "{name}". Here are views from where it is standing.\n\n'
                    "Write two or three sentences describing what is durably visible here, so "
                    "the robot can recognise this spot again later. Favour fixed landmarks, "
                    "layout, floor and wall surfaces over movable clutter. Write plain prose "
                    "with no preamble."
                ),
            }
        ]
        for jpeg in frames[:4]:
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": base64.b64encode(jpeg).decode(),
                    },
                }
            )
        try:
            response = await self._client.messages.create(
                model=self.llm.describe_model,
                max_tokens=300,
                messages=[{"role": "user", "content": content}],
            )
            return "".join(b.text for b in response.content if b.type == "text").strip()
        except Exception as exc:  # noqa: BLE001
            log.warning("scene description failed: %s", exc)
            return ""  # a place with keyframes and no prose is still usable

    # --- voice / text commands ----------------------------------------------

    async def handle_utterance(self, text: str) -> dict:
        """The single entry point for anything the operator says or types."""
        text = (text or "").strip()
        if not text:
            return {"ok": False, "detail": "empty"}
        self.bus.publish("log", text=f"Operator: {text}")

        intent = await self.router.route(text)
        log.info("utterance %r -> %s", text[:60], intent.intent)
        if intent.reply:
            self.bus.publish("say", text=intent.reply, language=intent.language)

        return await self._dispatch(intent, text)

    async def _dispatch(self, intent: Intent, original: str) -> dict:
        if intent.intent == "stop":
            self.emergency_stop("voice command")
            return {"ok": True, "intent": "stop", "detail": "Stopped."}

        if intent.intent == "drive":
            result = await self.manual_direction(
                intent.direction or "forward", intent.speed, intent.duration_ms
            )
            return {"intent": "drive", **result}

        if intent.intent == "teach_place":
            result = await self.teach_place(intent.place or original, intent.description)
            return {"intent": "teach_place", **result}

        if intent.intent == "goto":
            if intent.place and self.smap.find(intent.place) is None:
                detail = f"I don't know a place called {intent.place!r}."
                self.bus.publish("say", text=detail, language=intent.language)
                return {"ok": False, "intent": "goto", "detail": detail}
            # Navigating is itself an autonomous task; it needs the full loop,
            # not a special case that reimplements visual servoing badly.
            await self.start_mission(
                f"Navigate to the place called '{intent.place}'. "
                f"Call goto_place first, then drive there visually. "
                f"Say something when you arrive, then call mission_complete."
            )
            return {"ok": True, "intent": "goto", "detail": f"Heading to {intent.place}."}

        if intent.intent == "mode":
            await self.set_mode(intent.mode or "manual", "voice command")
            return {"ok": True, "intent": "mode", "detail": f"Mode: {self.mode.value}."}

        if intent.intent == "mission":
            goal = intent.goal or original
            if intent.language and not intent.language.lower().startswith("en"):
                goal += (
                    f"\n\nThe operator speaks {intent.language}. Use their language "
                    "for everything you say() and report."
                )
            await self.start_mission(goal)
            return {"ok": True, "intent": "mission", "detail": "Mission started."}

        return {"ok": True, "intent": "chat", "detail": intent.reply}
