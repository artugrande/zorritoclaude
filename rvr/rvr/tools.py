"""The rover's tool surface, as Claude sees it.

Two rules shape every tool here.

**Motion tools return what the rover can now see.** Perception and action are
one round trip, so the model never reasons about a photo taken before it moved.

**Tool results state what happened, not what was asked.** If the reflex layer
refused a drive, the result says so plainly. A model told its motion succeeded
when it did not will confidently navigate a map of a house it never moved
through, and every later inference inherits that error.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from .events import EventBus
from .mission import MissionLog
from .rover import Rover
from .semantic_map import Move, SemanticMap

log = logging.getLogger(__name__)


@dataclass
class ToolOutcome:
    text: str
    images: list[bytes] = field(default_factory=list)
    is_error: bool = False


@dataclass
class ToolContext:
    rover: Rover
    smap: SemanticMap
    missions: MissionLog
    bus: EventBus
    describe_scene: Callable[[list[bytes], str], Awaitable[str]] | None = None
    """Optional helper for captioning frames when teaching a place."""
    nav_target: str | None = None
    recent_moves: list[Move] = field(default_factory=list)


# --- Schemas -----------------------------------------------------------------

TOOL_SCHEMAS: list[dict] = [
    {
        "name": "drive",
        "description": (
            "Move the rover for a short, bounded time, then stop. Returns the "
            "camera view and sensor readings afterwards.\n\n"
            "There are no wheel encoders, so distances and angles are NOT "
            "repeatable — the same command covers different ground on carpet "
            "than on tile, and less as the battery drains. Never plan in metres "
            "or degrees. Drive in short steps and judge the result from the "
            "image each call returns.\n\n"
            "An on-board reflex layer will refuse or reduce forward motion near "
            "an obstacle. If the result says the motion was refused, the rover "
            "did NOT move: turn or back up instead of repeating the command."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "direction": {
                    "type": "string",
                    "enum": ["forward", "backward", "left", "right"],
                    "description": "'left'/'right' pivot in place; they do not arc.",
                },
                "speed": {
                    "type": "integer",
                    "minimum": 25,
                    "maximum": 100,
                    "description": "Motor power. Below ~25 the motors stall without moving.",
                },
                "duration_ms": {
                    "type": "integer",
                    "minimum": 100,
                    "maximum": 3000,
                    "description": "Capped at 3000ms. A pivot of ~400ms is roughly a modest turn.",
                },
            },
            "required": ["direction"],
        },
    },
    {
        "name": "look",
        "description": (
            "Take a fresh photo, optionally tilting the camera first. The camera "
            "tilts only — there is no pan axis, so to look sideways you must "
            "turn the whole rover with drive()."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tilt": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 140,
                    "description": "0 looks down, 90 is level, 140 looks up. Omit to keep current.",
                }
            },
        },
    },
    {
        "name": "scan",
        "description": (
            "Pivot in place through a full rotation, photographing at each step. "
            "Use this to get your bearings on arriving somewhere new. Steps are "
            "open-loop, so treat the images as 'views from here', not as "
            "calibrated compass bearings. This takes several seconds."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "steps": {"type": "integer", "minimum": 3, "maximum": 8, "default": 6}
            },
        },
    },
    {
        "name": "sensors",
        "description": (
            "Read ultrasonic distance, the two IR obstacle sensors and battery "
            "voltage, without moving or taking a photo."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "set_lights",
        "description": (
            "Set the chassis RGB strip colour and/or the front lamp. Use the lamp "
            "when the view is too dark to interpret, and the strip to signal state "
            "to a human watching the rover."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "rgb": {
                    "type": "array",
                    "items": {"type": "integer", "minimum": 0, "maximum": 255},
                    "minItems": 3,
                    "maxItems": 3,
                },
                "lamp": {"type": "boolean"},
            },
        },
    },
    {
        "name": "recall_places",
        "description": (
            "List every place a human has taught the rover, with descriptions. "
            "Call this before navigating anywhere by name."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "goto_place",
        "description": (
            "Begin navigating to a taught place. This does NOT drive there — it "
            "returns that place's stored keyframes so you can recognise it, plus "
            "any hint about how it was approached during the demonstration.\n\n"
            "Navigate by visual servoing: compare what look() returns against "
            "those keyframes, drive a short step toward whatever matches, and "
            "repeat. Call arrived_at() once the current view genuinely matches. "
            "If you cannot find it after roughly a dozen moves, say so with "
            "report_finding rather than wandering."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
    },
    {
        "name": "arrived_at",
        "description": (
            "Confirm the rover is now at a taught place. Only call this when the "
            "live view actually matches its keyframes — a false arrival corrupts "
            "the map for every later mission."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
    },
    {
        "name": "remember_place",
        "description": (
            "Save the rover's current location as a named place, using the current "
            "view as its keyframes. Use this when you find somewhere worth being "
            "able to return to. Prefer names a human would use out loud."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "description": {
                    "type": "string",
                    "description": "What is here and how to recognise it visually.",
                },
                "scan_first": {
                    "type": "boolean",
                    "default": True,
                    "description": "Capture views all around rather than just straight ahead.",
                },
            },
            "required": ["name", "description"],
        },
    },
    {
        "name": "report_finding",
        "description": (
            "Record something worth telling the operator, with the current camera "
            "view attached. This is the mission's output — an unreported "
            "observation may as well not have happened.\n\n"
            "Report what is actually interesting given the mission, not an "
            "inventory of everything visible. Include your reasoning, not just a "
            "label: 'dark textile under the table, likely a sock, inconsistent "
            "with the rest of the floor' beats 'sock detected'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "importance": {
                    "type": "string",
                    "enum": ["routine", "notable", "important"],
                    "default": "notable",
                },
            },
            "required": ["text"],
        },
    },
    {
        "name": "say",
        "description": (
            "Speak aloud to the operator through the control app. Use it for "
            "things worth hearing in the moment — arriving somewhere, a surprise, "
            "a question. Keep it to one short spoken sentence; this is speech, "
            "not a log line. Findings still need report_finding."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "mission_complete",
        "description": (
            "End the mission and hand in your report. Call this when the goal is "
            "met, or when you are certain you cannot meet it — in which case say "
            "plainly what stopped you."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "What you did, what you found, and what you could not resolve.",
                },
                "success": {"type": "boolean", "default": True},
            },
            "required": ["summary"],
        },
    },
]

TERMINAL_TOOLS = {"mission_complete"}

_DIRECTIONS = {
    "forward": lambda s: (s, s),
    "backward": lambda s: (-s, -s),
    "left": lambda s: (-s, s),
    "right": lambda s: (s, -s),
}


# --- Execution ---------------------------------------------------------------

async def execute(ctx: ToolContext, name: str, args: dict) -> ToolOutcome:
    """Run one tool call. Never raises -- failures come back as error outcomes."""
    handler = _HANDLERS.get(name)
    if handler is None:
        return ToolOutcome(f"Unknown tool {name!r}.", is_error=True)
    try:
        return await handler(ctx, args)
    except Exception as exc:  # noqa: BLE001
        log.exception("tool %s failed", name)
        return ToolOutcome(f"Tool {name} failed: {type(exc).__name__}: {exc}", is_error=True)


async def _drive(ctx: ToolContext, args: dict) -> ToolOutcome:
    direction = args.get("direction", "forward")
    if direction not in _DIRECTIONS:
        return ToolOutcome(f"Unknown direction {direction!r}.", is_error=True)
    speed = int(args.get("speed", 55))
    duration = int(args.get("duration_ms", 700 if direction in ("forward", "backward") else 420))

    left, right = _DIRECTIONS[direction](speed)
    result = await ctx.rover.drive(left, right, duration, source="agent")
    ctx.bus.publish("drive", source="agent", direction=direction, result=result.describe())

    if not result.vetoed:
        ctx.recent_moves.append(Move(result.applied[0], result.applied[1], result.duration_ms))
        del ctx.recent_moves[:-40]

    frame = await ctx.rover.snapshot()
    return ToolOutcome(result.describe(), images=[frame] if frame else [])


async def _look(ctx: ToolContext, args: dict) -> ToolOutcome:
    prefix = ""
    if "tilt" in args and args["tilt"] is not None:
        angle = await ctx.rover.tilt(int(args["tilt"]))
        prefix = f"Camera tilted to {angle} (90 = level). "
    frame = await ctx.rover.snapshot()
    if frame is None:
        return ToolOutcome(prefix + "No camera frame available — the video link is down.", is_error=True)
    return ToolOutcome(prefix + f"Current view. {ctx.rover.telemetry.describe()}", images=[frame])


async def _scan(ctx: ToolContext, args: dict) -> ToolOutcome:
    steps = max(3, min(8, int(args.get("steps", 6))))
    frames = await ctx.rover.scan(steps=steps)
    if not frames:
        return ToolOutcome("Scan produced no frames — the video link is down.", is_error=True)
    return ToolOutcome(
        f"Scanned {len(frames)} views turning right through roughly a full circle, "
        f"in order. The rover now faces approximately its original heading. "
        f"{ctx.rover.telemetry.describe()}",
        images=frames,
    )


async def _sensors(ctx: ToolContext, _args: dict) -> ToolOutcome:
    telemetry = ctx.rover.telemetry
    freshness = "" if ctx.rover.telemetry_fresh else " (STALE — the rover link may be down)"
    return ToolOutcome(telemetry.describe() + freshness)


async def _set_lights(ctx: ToolContext, args: dict) -> ToolOutcome:
    done = []
    if "rgb" in args and args["rgb"]:
        r, g, b = (list(args["rgb"]) + [0, 0, 0])[:3]
        await ctx.rover.set_leds(int(r), int(g), int(b))
        done.append(f"strip set to ({r}, {g}, {b})")
    if "lamp" in args and args["lamp"] is not None:
        await ctx.rover.set_lamp(bool(args["lamp"]))
        done.append(f"lamp {'on' if args['lamp'] else 'off'}")
    return ToolOutcome(("Lights: " + ", ".join(done)) if done else "Nothing to change.")


async def _recall_places(ctx: ToolContext, _args: dict) -> ToolOutcome:
    return ToolOutcome("Known places:\n" + ctx.smap.catalogue())


async def _goto_place(ctx: ToolContext, args: dict) -> ToolOutcome:
    name = str(args.get("name", ""))
    place = ctx.smap.find(name)
    if place is None:
        return ToolOutcome(
            f"No place called {name!r}. Known places:\n{ctx.smap.catalogue()}", is_error=True
        )
    ctx.nav_target = place.id
    ctx.bus.publish("mission", text=f"Navigating to {place.name}")

    frames = ctx.smap.keyframe_bytes(place)
    lines = [
        f'Target: "{place.name}". {place.description or "(no description stored)"}',
        f"{len(frames)} keyframes of this place follow — this is what it should look like.",
    ]
    if place.approach:
        forward = sum(1 for m in place.approach if m.left > 0 and m.right > 0)
        turns = sum(1 for m in place.approach if (m.left > 0) != (m.right > 0))
        lines.append(
            f"Hint from the demonstration: it was reached in about {len(place.approach)} moves "
            f"({forward} forward, {turns} turns). This is a rough prior about effort and "
            f"direction only — do NOT replay it as a route, there is no odometry."
        )
    lines.append(
        "Now navigate visually: look(), compare with the keyframes, drive one short step "
        "toward the best match, repeat. Call arrived_at() when the view truly matches."
    )
    return ToolOutcome("\n".join(lines), images=frames)


async def _arrived_at(ctx: ToolContext, args: dict) -> ToolOutcome:
    place = ctx.smap.find(str(args.get("name", "")))
    if place is None:
        return ToolOutcome(f"No place called {args.get('name')!r}.", is_error=True)
    ctx.smap.mark_visited(place.id)
    ctx.nav_target = None
    ctx.bus.publish("mission", text=f"Arrived at {place.name}")

    frame = await ctx.rover.snapshot()
    if frame:  # a fresh view of a known place is a free map improvement
        ctx.smap.learn(place.name, [frame])
    return ToolOutcome(
        f'Recorded arrival at "{place.name}" (visit {place.visits}). '
        f"The current view was added to its keyframes.",
        images=[frame] if frame else [],
    )


async def _remember_place(ctx: ToolContext, args: dict) -> ToolOutcome:
    name = str(args.get("name", "")).strip()
    if not name:
        return ToolOutcome("A place needs a name.", is_error=True)
    description = str(args.get("description", ""))

    if args.get("scan_first", True):
        frames = await ctx.rover.scan(steps=4)
    else:
        frame = await ctx.rover.snapshot()
        frames = [frame] if frame else []
    if not frames:
        return ToolOutcome("Cannot learn a place with no camera frames.", is_error=True)

    place = ctx.smap.learn(
        name, frames, description=description, approach=list(ctx.recent_moves)
    )
    ctx.recent_moves.clear()
    ctx.bus.publish("place", name=place.name, description=place.description, id=place.id)
    return ToolOutcome(
        f'Saved "{place.name}" with {len(frames)} new keyframes '
        f"({len(place.keyframes)} stored in total)."
    )


async def _report_finding(ctx: ToolContext, args: dict) -> ToolOutcome:
    text = str(args.get("text", "")).strip()
    if not text:
        return ToolOutcome("A finding needs text.", is_error=True)
    frame = await ctx.rover.snapshot(fresh=False)
    place = ctx.smap.places.get(ctx.nav_target) if ctx.nav_target else None
    finding = ctx.missions.add_finding(
        text,
        importance=str(args.get("importance", "notable")),
        jpeg=frame,
        place=place.name if place else None,
    )
    ctx.bus.publish(
        "finding",
        id=finding.id,
        text=finding.text,
        importance=finding.importance,
        image=finding.image,
    )
    return ToolOutcome(f"Finding recorded [{finding.importance}].")


async def _say(ctx: ToolContext, args: dict) -> ToolOutcome:
    text = str(args.get("text", "")).strip()
    if text:
        ctx.bus.publish("say", text=text)
    return ToolOutcome("Spoken to the operator." if text else "Nothing to say.")


async def _mission_complete(ctx: ToolContext, args: dict) -> ToolOutcome:
    summary = str(args.get("summary", ""))
    success = bool(args.get("success", True))
    mission = ctx.missions.finish(summary, "complete" if success else "aborted")
    ctx.bus.publish(
        "mission",
        text="Mission complete" if success else "Mission aborted",
        summary=summary,
        report=ctx.missions.report(mission) if mission else "",
    )
    return ToolOutcome("Mission closed.")


_HANDLERS: dict[str, Callable[[ToolContext, dict], Awaitable[ToolOutcome]]] = {
    "drive": _drive,
    "look": _look,
    "scan": _scan,
    "sensors": _sensors,
    "set_lights": _set_lights,
    "recall_places": _recall_places,
    "goto_place": _goto_place,
    "arrived_at": _arrived_at,
    "remember_place": _remember_place,
    "report_finding": _report_finding,
    "say": _say,
    "mission_complete": _mission_complete,
}
