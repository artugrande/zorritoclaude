"""The deliberative layer: a Claude tool loop that drives the rover.

Runs at roughly 1 Hz against a reflex layer running at 10 Hz. It issues
intentions ("turn until the doorway is centred") and never raw motor timings it
expects to be repeatable, because on this chassis they are not.

The loop is *interruptible mid-tool*. When the operator grabs the controls, the
in-flight tool is cancelled and its result becomes an explicit "interrupted"
message rather than being dropped — every ``tool_use`` block must be answered by
a matching ``tool_result`` or the next API call is rejected outright. On resume,
the model is told it was moved and shown where it is now, so it re-orients
instead of continuing from a stale belief about its position.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import logging
import time
from dataclasses import dataclass, field

import anthropic

from .llm import NO_CLIENT, make_client
from .tools import TERMINAL_TOOLS, TOOL_SCHEMAS, ToolContext, ToolOutcome, execute

log = logging.getLogger(__name__)

# Sonnet 5 by default: this is a perception-action loop where a second of extra
# latency is a second of the rover sitting still, and the reasoning per step is
# modest. Set model: claude-opus-5 in config for missions that need deeper
# planning and can afford the round trip.
DEFAULT_MODEL = "claude-sonnet-5"
MAX_IMAGES_IN_CONTEXT = 5

# Sent when the model replies in prose instead of acting. Matched back by exact
# identity rather than by searching its wording -- substring-matching your own
# prose is how a loop quietly stops detecting its own state.
NUDGE_TEXT = (
    "Continue the mission by calling a tool, or call mission_complete() if you are done."
)
MAX_IMAGE_EDGE = 768

SYSTEM_PROMPT = """\
You are the mind of a six-wheeled Mars-rover-style robot exploring a home or office. \
You perceive only through its camera and three crude sensors, and you act only through \
its tools. Nothing else about the world is available to you.

Your body, honestly described:
- Six wheels, skid steer. Turning means spinning both tracks in opposition.
- NO wheel encoders, NO compass, NO odometry. You cannot measure how far you moved or \
how far you turned. Identical commands give different results on different floors and \
at different battery levels. Never plan in metres or degrees, and never assume a \
sequence of moves is repeatable.
- One camera on a tilt-only servo. To look left, you must turn the whole rover.
- An ultrasonic range finder facing forward, and two IR obstacle sensors, left and right. \
They are short range and easily fooled by dark or soft surfaces.
- A reflex layer below you refuses or slows forward motion near obstacles. It is not a \
guarantee. It sees nothing below bumper height, nothing behind, and nothing at table-edge \
height. Drops and overhangs are entirely your problem.

How to operate:
- Work in short steps: move a little, look, decide. Do not chain many blind moves.
- Read every tool result. If it says a motion was refused, you did not move — turn or \
back up rather than repeating the command.
- Navigate by what you see, not by dead reckoning. "Turn until the doorway is centred, \
then go forward until the chair fills the lower half of the frame" is a plan that works. \
"Go forward 2 metres then turn 90 degrees" is not.
- If you are lost, scan() and re-orient against known places. Say so out loud rather \
than wandering silently.
- Battery is finite. Prefer the mission's goal over exhaustive coverage.

What you are for:
You are not an object detector. Deciding what is worth looking at, forming a hypothesis \
about what you are seeing, and choosing where to go next because of it — that is the job. \
Report observations with your reasoning attached, not bare labels.

Use say() for short things the operator should hear in the moment. Use report_finding() \
for anything that should survive the mission. Call mission_complete() when you are done \
or certainly stuck.
"""


@dataclass
class AgentState:
    running: bool = False
    paused: bool = False
    goal: str = ""
    steps: int = 0
    last_text: str = ""
    pause_reason: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    started_at: float | None = None
    error: str | None = None

    def as_dict(self) -> dict:
        return {
            **self.__dict__,
            "elapsed_s": None if self.started_at is None else round(time.time() - self.started_at, 1),
        }


class AgentSession:
    """One autonomous mission, start to finish."""

    def __init__(
        self,
        ctx: ToolContext,
        *,
        api_key: str | None = None,
        model: str = DEFAULT_MODEL,
        max_steps: int = 60,
    ) -> None:
        self.ctx = ctx
        self.model = model
        self.max_steps = max_steps
        self.state = AgentState()

        self._client = make_client(api_key)
        self._messages: list[dict] = []
        self._may_act = asyncio.Event()
        self._may_act.set()
        self._tool_task: asyncio.Task | None = None
        self._interrupted = False
        self._resume_notes: list[str] = []

    # --- control from the arbiter -------------------------------------------

    def interrupt(self, reason: str) -> None:
        """Pause the agent, cancelling whatever tool is in flight.

        Synchronous so a takeover lands immediately -- the operator pressing a
        key must not queue behind the event loop.
        """
        if not self.state.running or self.state.paused:
            return
        self._interrupted = True
        self._may_act.clear()
        self.state.paused = True
        self.state.pause_reason = reason
        if self._tool_task is not None and not self._tool_task.done():
            self._tool_task.cancel()
        self.ctx.bus.publish("agent", status="paused", reason=reason)
        log.info("agent paused: %s", reason)

    def resume(self, note: str = "") -> None:
        """Hand control back, telling the model what happened while it was away."""
        if not self.state.paused:
            return
        if note:
            self._resume_notes.append(note)
        self.state.paused = False
        self.state.pause_reason = None
        self._interrupted = False
        self._may_act.set()
        self.ctx.bus.publish("agent", status="running", reason="resumed")
        log.info("agent resumed")

    # --- the loop ------------------------------------------------------------

    async def run(self, goal: str) -> str:
        self.state = AgentState(running=True, goal=goal, started_at=time.time())
        if self._client is None:
            self.state.running = False
            self.state.error = NO_CLIENT
            self.ctx.bus.publish("error", text=NO_CLIENT)
            return NO_CLIENT

        mission = self.ctx.missions.start(goal)
        self.ctx.bus.publish("mission", text=f"Mission started: {goal}", goal=goal, id=mission.id)

        opening: list[dict] = [{"type": "text", "text": self._opening_text(goal)}]
        frame = await self.ctx.rover.snapshot(fresh=False, settle_ms=0)
        if frame:
            opening.append(_image_block(frame))
            opening.append({"type": "text", "text": "This is the rover's current view."})
        self._messages = [{"role": "user", "content": opening}]

        try:
            return await self._loop(mission)
        except asyncio.CancelledError:
            self.ctx.missions.finish("Mission cancelled by the operator.", "aborted")
            self.ctx.bus.publish("mission", text="Mission cancelled")
            raise
        except Exception as exc:  # noqa: BLE001
            self.state.error = f"{type(exc).__name__}: {exc}"
            log.exception("agent loop failed")
            self.ctx.missions.finish(f"Mission failed: {self.state.error}", "aborted")
            self.ctx.bus.publish("error", text=self.state.error)
            return self.state.error
        finally:
            self.state.running = False
            self.ctx.rover.halt("agent finished")

    def _opening_text(self, goal: str) -> str:
        return (
            f"MISSION: {goal}\n\n"
            f"Places already taught to you by the operator:\n{self.ctx.smap.catalogue()}\n\n"
            "Begin. Look before you move."
        )

    async def _loop(self, mission) -> str:
        while self.state.steps < self.max_steps:
            await self._gate()
            self.state.steps += 1
            mission.steps = self.state.steps

            response = await self._call_model()
            if response is None:
                return "Gave up after repeated API failures."

            self._messages.append({"role": "assistant", "content": response.content})
            text = "".join(
                block.text for block in response.content if block.type == "text"
            ).strip()
            if text:
                self.state.last_text = text
                self.ctx.bus.publish("agent", status="thinking", text=text)

            tool_uses = [block for block in response.content if block.type == "tool_use"]
            if not tool_uses:
                # The model answered in prose instead of acting. Ask once for an
                # action; if it does it again, it is finished in all but name.
                if response.stop_reason == "end_turn" and self._last_was_nudge():
                    self.ctx.missions.finish(text or "Ended without an explicit summary.")
                    return text
                self._append_user([{"type": "text", "text": NUDGE_TEXT}])
                continue

            results, terminal = await self._run_tools(tool_uses)
            self._append_user(results)
            self._trim_images()

            if terminal:
                return self.state.last_text or "Mission complete."

        self.ctx.missions.finish(
            f"Step budget exhausted after {self.max_steps} steps.", "aborted"
        )
        self.ctx.bus.publish("mission", text=f"Stopped: hit the {self.max_steps}-step budget")
        return f"Stopped after {self.max_steps} steps."

    async def _run_tools(self, tool_uses: list) -> tuple[list[dict], bool]:
        """Execute each requested tool, answering every one even if interrupted."""
        results: list[dict] = []
        terminal = False
        aborted = False

        for block in tool_uses:
            if aborted:
                results.append(_tool_result(block.id, "Not executed: the operator took control."))
                continue

            self.ctx.bus.publish("agent", status="acting", tool=block.name, args=block.input)
            self._tool_task = asyncio.create_task(execute(self.ctx, block.name, dict(block.input)))
            try:
                outcome = await self._tool_task
            except asyncio.CancelledError:
                if not self._interrupted:
                    raise  # a real shutdown, not a takeover
                self.ctx.rover.halt("takeover")
                outcome = ToolOutcome(
                    "INTERRUPTED: the operator took manual control part-way through this "
                    "action. Treat its effect as unknown and re-orient before continuing."
                )
                aborted = True
            finally:
                self._tool_task = None

            results.append(_tool_result(block.id, outcome.text, outcome.images, outcome.is_error))
            if block.name in TERMINAL_TOOLS:
                terminal = True

        return results, terminal

    async def _gate(self) -> None:
        """Block while paused, and fold in any takeover note on the way out."""
        if self._may_act.is_set():
            return
        await self._may_act.wait()

        notes = self._resume_notes
        self._resume_notes = []
        if not notes:
            return

        content: list[dict] = [
            {
                "type": "text",
                "text": (
                    "CONTROL RETURNED TO YOU. While you were paused: "
                    + " ".join(notes)
                    + " Your previous position and heading are no longer reliable. "
                    "Look around and re-establish where you are before acting on any "
                    "plan you made earlier."
                ),
            }
        ]
        frame = await self.ctx.rover.snapshot(fresh=False, settle_ms=0)
        if frame:
            content.append(_image_block(frame))
            content.append({"type": "text", "text": "This is the view now."})
        self._append_user(content)

    def _append_user(self, content: list[dict]) -> None:
        """Append user content, merging into the previous user turn if there is one.

        The Messages API expects alternating roles, and a takeover note landing
        right after a batch of tool results would otherwise produce two user
        turns in a row.
        """
        if self._messages and self._messages[-1]["role"] == "user":
            existing = self._messages[-1]["content"]
            if isinstance(existing, list):
                existing.extend(content)
                return
        self._messages.append({"role": "user", "content": content})

    def _last_was_nudge(self) -> bool:
        """Did we already ask this model to call a tool and get prose back again?

        Checks the most recent USER turn, not the last message -- by the time
        this runs, the assistant's reply has already been appended.
        """
        for message in reversed(self._messages):
            if message["role"] != "user":
                continue
            content = message["content"]
            if not isinstance(content, list):
                return False
            return any(
                isinstance(block, dict) and block.get("text") == NUDGE_TEXT
                for block in content
            )
        return False

    async def _call_model(self, attempts: int = 3):
        """One API round trip, retrying the failures that are worth retrying."""
        delay = 2.0
        for attempt in range(attempts):
            try:
                response = await self._client.messages.create(
                    model=self.model,
                    max_tokens=1500,
                    system=SYSTEM_PROMPT,
                    tools=TOOL_SCHEMAS,
                    messages=self._messages,
                )
                self.state.tokens_in += response.usage.input_tokens
                self.state.tokens_out += response.usage.output_tokens
                return response
            except (anthropic.RateLimitError, anthropic.InternalServerError, anthropic.APIConnectionError) as exc:
                log.warning("model call failed (attempt %d/%d): %s", attempt + 1, attempts, exc)
                # Stop the rover while we wait: it must never coast through a backoff.
                self.ctx.rover.halt("api backoff")
                if attempt == attempts - 1:
                    self.ctx.bus.publish("error", text=f"Anthropic API unavailable: {exc}")
                    return None
                await asyncio.sleep(delay)
                delay *= 2
            except anthropic.BadRequestError:
                log.exception("malformed request; message history is likely corrupt")
                raise
        return None

    def _trim_images(self) -> None:
        """Keep only the most recent images; replace older ones with a placeholder.

        Every frame is ~400 tokens and a mission is dozens of steps, so without
        this the context grows without bound and cost grows with it. Recent
        frames are what matter for acting; what older ones *meant* is already in
        the tool-result text beside them.
        """
        kept = 0
        for message in reversed(self._messages):
            content = message.get("content")
            if not isinstance(content, list):
                continue
            for index, block in enumerate(content):
                block_dict = block if isinstance(block, dict) else None
                if block_dict is None:
                    continue
                if block_dict.get("type") == "image":
                    kept += 1
                    if kept > MAX_IMAGES_IN_CONTEXT:
                        content[index] = {"type": "text", "text": "[earlier image dropped]"}
                elif block_dict.get("type") == "tool_result":
                    inner = block_dict.get("content")
                    if not isinstance(inner, list):
                        continue
                    for inner_index, inner_block in enumerate(inner):
                        if isinstance(inner_block, dict) and inner_block.get("type") == "image":
                            kept += 1
                            if kept > MAX_IMAGES_IN_CONTEXT:
                                inner[inner_index] = {
                                    "type": "text",
                                    "text": "[earlier image dropped]",
                                }


# --- block helpers -----------------------------------------------------------

def _image_block(jpeg: bytes) -> dict:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": base64.b64encode(_shrink(jpeg)).decode(),
        },
    }


def _tool_result(
    tool_use_id: str, text: str, images: list[bytes] | None = None, is_error: bool = False
) -> dict:
    content: list[dict] = [{"type": "text", "text": text}]
    for jpeg in images or []:
        content.append(_image_block(jpeg))
    result = {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}
    if is_error:
        result["is_error"] = True
    return result


def _shrink(jpeg: bytes, max_edge: int = MAX_IMAGE_EDGE) -> bytes:
    """Downscale oversized frames. A no-op for the stock VGA camera.

    Only matters if FRAMESIZE is raised in the ESP32 firmware; beyond roughly
    this size the model gains nothing and every frame costs more.
    """
    try:
        from PIL import Image
    except ImportError:
        return jpeg
    try:
        with Image.open(io.BytesIO(jpeg)) as image:
            if max(image.size) <= max_edge:
                return jpeg
            image.thumbnail((max_edge, max_edge))
            buffer = io.BytesIO()
            image.convert("RGB").save(buffer, format="JPEG", quality=80)
            return buffer.getvalue()
    except Exception:  # noqa: BLE001 - a corrupt frame is not worth failing over
        return jpeg
