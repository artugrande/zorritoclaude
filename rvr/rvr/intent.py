"""Turning what the operator said into what the rover should do.

Two tiers, for the same reason the rover itself has two tiers.

"Stop" cannot wait on a network round trip. If someone is shouting at a robot
heading for the stairs, a 1.5 second classification is 1.5 seconds too slow, so
stop words are matched locally against a small multilingual list and executed
before anything else runs.

Everything else goes to Claude, because the alternative is a regex zoo that
breaks on the first sentence phrased slightly differently, in the wrong
language, or mangled by speech recognition. "esto es la cocina", "this is the
kitchen" and "ok so like, call this spot the kitchen" should all land in the
same place, and that is a language problem, not a parsing problem.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

import anthropic

from .llm import NO_CLIENT, make_client

log = logging.getLogger(__name__)

FAST_MODEL = "claude-haiku-4-5-20251001"

# Deliberately blunt and deliberately multilingual. False positives cost a
# needless stop; false negatives cost a collision.
STOP_WORDS = re.compile(
    r"\b(stop|halt|freeze|abort|brake|"
    r"par[aá]|pare|pará|frena|frená|alto|quieto|detente|"
    r"arr[eê]te|stopp|alt)\b",
    re.IGNORECASE,
)

INTENT_TOOL = {
    "name": "route_command",
    "description": "Classify one spoken or typed command from the rover's operator.",
    "input_schema": {
        "type": "object",
        "properties": {
            "intent": {
                "type": "string",
                "enum": ["stop", "drive", "teach_place", "goto", "mission", "mode", "chat"],
                "description": (
                    "stop: halt now. "
                    "drive: one immediate short movement ('go forward a bit', 'turn left'). "
                    "teach_place: naming where the rover is right now "
                    "('this is the kitchen', 'call this spot the desk'). "
                    "goto: travel to an already-named place. "
                    "mission: an open-ended task to carry out autonomously "
                    "('explore the living room and tell me what's out of place'). "
                    "mode: switch control mode explicitly. "
                    "chat: a question or remark needing no rover action."
                ),
            },
            "direction": {"type": "string", "enum": ["forward", "backward", "left", "right"]},
            "speed": {"type": "integer", "minimum": 25, "maximum": 100},
            "duration_ms": {"type": "integer", "minimum": 100, "maximum": 3000},
            "place": {
                "type": "string",
                "description": "Place name for teach_place/goto, as the operator said it, without articles like 'the'.",
            },
            "description": {
                "type": "string",
                "description": "For teach_place: any detail the operator gave about the spot.",
            },
            "goal": {
                "type": "string",
                "description": "For mission: the task, rewritten as a clear standalone instruction.",
            },
            "mode": {"type": "string", "enum": ["manual", "auto", "teach"]},
            "reply": {
                "type": "string",
                "description": "A short spoken reply to the operator, in THEIR language.",
            },
            "language": {"type": "string", "description": "BCP-47 tag of the operator's language, e.g. es-AR."},
        },
        "required": ["intent", "reply"],
    },
}

SYSTEM = """\
You route commands for a small exploration robot with a camera.

The operator is speaking out loud, so the text may be mistranscribed, informal, \
or in any language. Infer intent generously rather than demanding exact phrasing.

Always answer in the operator's own language in `reply`, and keep it to one short \
spoken sentence — it will be read aloud.

Distinguish carefully:
- A single immediate movement is `drive`.
- An open-ended task the robot should carry out on its own is `mission`.
- Naming the robot's CURRENT location is `teach_place`. Asking it to travel \
somewhere already named is `goto`.
"""


@dataclass
class Intent:
    intent: str
    reply: str = ""
    direction: str | None = None
    speed: int = 55
    duration_ms: int = 700
    place: str | None = None
    description: str = ""
    goal: str | None = None
    mode: str | None = None
    language: str = "en"
    raw: dict = field(default_factory=dict)


def looks_like_stop(text: str) -> bool:
    """Local fast path. Must never need the network."""
    return bool(STOP_WORDS.search(text or ""))


class IntentRouter:
    def __init__(self, *, api_key: str | None = None, model: str = FAST_MODEL) -> None:
        self.model = model
        self._client = make_client(api_key)

    async def route(self, text: str) -> Intent:
        text = (text or "").strip()
        if not text:
            return Intent(intent="chat", reply="")
        if looks_like_stop(text):
            return Intent(intent="stop", reply="Stopping.", raw={"fast_path": True})

        if self._client is None:
            # Stop still worked above; everything else needs the model.
            return Intent(intent="chat", reply=NO_CLIENT, raw={"no_client": True})

        try:
            response = await self._client.messages.create(
                model=self.model,
                max_tokens=400,
                system=SYSTEM,
                tools=[INTENT_TOOL],
                tool_choice={"type": "tool", "name": "route_command"},
                messages=[{"role": "user", "content": text}],
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("intent routing failed (%s); treating as a mission", exc)
            # Falling back to `mission` keeps a misrouted command inside the
            # agent loop, where the reflex layer still governs every motion.
            return Intent(intent="mission", goal=text, reply="", raw={"error": str(exc)})

        for block in response.content:
            if block.type == "tool_use":
                args = dict(block.input)
                return Intent(
                    intent=str(args.get("intent", "chat")),
                    reply=str(args.get("reply", "")),
                    direction=args.get("direction"),
                    speed=int(args.get("speed", 55)),
                    duration_ms=int(args.get("duration_ms", 700)),
                    place=args.get("place"),
                    description=str(args.get("description", "")),
                    goal=args.get("goal") or text,
                    mode=args.get("mode"),
                    language=str(args.get("language", "en")),
                    raw=args,
                )

        log.warning("router returned no tool call for %r", text[:80])
        return Intent(intent="mission", goal=text, reply="")

    def __repr__(self) -> str:
        return f"IntentRouter(model={self.model!r})"
