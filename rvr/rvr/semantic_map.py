"""Named places, learned by being shown them.

This chassis has no wheel encoders, no compass and no odometry of any kind, so
metric navigation is off the table -- "drive 1 metre" lands somewhere different
on carpet than on tile, and differently again at 60% battery. Rather than fake
a coordinate frame, a place here is *what it looks like from there*: a handful
of keyframes plus a description, written while you drive the rover around and
tell it where it is.

Recognition is then a visual question ("does this view match any known place?")
which is exactly what a vision model is good at, and navigation is visual
servoing toward a remembered view -- unreliable, but honestly unreliable, and
it degrades into "keep looking" instead of confidently driving into a wall.

Action traces recorded during a demonstration are kept as *hints* only. Replaying
them is dead reckoning and drifts badly; it is useful as a prior for which way to
set off, never as a route.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

MAX_KEYFRAMES = 8


@dataclass
class Observation:
    text: str
    at: float = field(default_factory=time.time)
    image: str | None = None


@dataclass
class Move:
    """One manual motion, as recorded during a demonstration."""

    left: int
    right: int
    duration_ms: int
    at: float = field(default_factory=time.time)


@dataclass
class Place:
    id: str
    name: str
    aliases: list[str] = field(default_factory=list)
    description: str = ""
    keyframes: list[str] = field(default_factory=list)
    """Repo-relative paths to JPEGs, most recent last."""
    observations: list[Observation] = field(default_factory=list)
    approach: list[Move] = field(default_factory=list)
    """The moves that led here during the demonstration. A hint, not a route."""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    visits: int = 0

    def matches(self, query: str) -> bool:
        needle = query.strip().lower()
        if not needle:
            return False
        names = [self.name.lower(), *(alias.lower() for alias in self.aliases)]
        return any(needle == name or needle in name or name in needle for name in names)

    def summary(self) -> str:
        parts = [f'"{self.name}"']
        if self.aliases:
            parts.append(f"(also: {', '.join(self.aliases)})")
        if self.description:
            parts.append(f"-- {self.description}")
        parts.append(f"[{len(self.keyframes)} keyframes, visited {self.visits}x]")
        return " ".join(parts)


class SemanticMap:
    """Persistent place store. Keyframes live as JPEGs next to the index."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.images = self.root / "places"
        self.index_path = self.root / "places.json"
        self.places: dict[str, Place] = {}
        self.root.mkdir(parents=True, exist_ok=True)
        self.images.mkdir(parents=True, exist_ok=True)
        self.load()

    # --- persistence ---------------------------------------------------------

    def load(self) -> None:
        if not self.index_path.exists():
            return
        try:
            raw = json.loads(self.index_path.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            log.error("could not read %s (%s); starting with an empty map", self.index_path, exc)
            return
        for entry in raw.get("places", []):
            entry["observations"] = [Observation(**o) for o in entry.get("observations", [])]
            entry["approach"] = [Move(**m) for m in entry.get("approach", [])]
            place = Place(**entry)
            self.places[place.id] = place
        log.info("loaded %d places from %s", len(self.places), self.index_path)

    def save(self) -> None:
        payload = {"version": 1, "places": [asdict(place) for place in self.places.values()]}
        # Write-then-rename: a crash mid-save must not leave a half-written map.
        temp = self.index_path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
        temp.replace(self.index_path)

    # --- queries -------------------------------------------------------------

    def find(self, query: str) -> Place | None:
        for place in self.places.values():
            if place.matches(query):
                return place
        return None

    def all(self) -> list[Place]:
        return sorted(self.places.values(), key=lambda place: place.created_at)

    def catalogue(self) -> str:
        """The place list as the agent sees it in its system prompt."""
        if not self.places:
            return "No places have been taught yet."
        return "\n".join(f"- {place.summary()}" for place in self.all())

    # --- mutation ------------------------------------------------------------

    def learn(
        self,
        name: str,
        frames: list[bytes],
        *,
        description: str = "",
        aliases: list[str] | None = None,
        approach: list[Move] | None = None,
    ) -> Place:
        """Create or update a place from what the camera can see of it.

        Re-teaching an existing name adds keyframes instead of replacing it, so
        showing the rover the kitchen from a second doorway makes recognition
        better rather than overwriting the first view.
        """
        place = self.find(name)
        if place is None:
            place = Place(id=uuid.uuid4().hex[:8], name=name.strip())
            self.places[place.id] = place
            log.info("learning new place %r", place.name)
        else:
            log.info("updating known place %r", place.name)

        if description:
            place.description = description
        if aliases:
            place.aliases = sorted({*place.aliases, *aliases})
        if approach:
            place.approach = approach

        folder = self.images / place.id
        folder.mkdir(parents=True, exist_ok=True)
        for index, jpeg in enumerate(frames):
            path = folder / f"{int(time.time())}_{index}.jpg"
            path.write_bytes(jpeg)
            place.keyframes.append(str(path.relative_to(self.root)))

        # Keep the newest views; an old one of a room that has since been
        # rearranged actively hurts recognition.
        for stale in place.keyframes[:-MAX_KEYFRAMES]:
            (self.root / stale).unlink(missing_ok=True)
        place.keyframes = place.keyframes[-MAX_KEYFRAMES:]

        place.updated_at = time.time()
        self.save()
        return place

    def add_observation(self, place_id: str, text: str, image: str | None = None) -> None:
        place = self.places.get(place_id)
        if place is None:
            return
        place.observations.append(Observation(text=text, image=image))
        place.updated_at = time.time()
        self.save()

    def mark_visited(self, place_id: str) -> None:
        place = self.places.get(place_id)
        if place is None:
            return
        place.visits += 1
        place.updated_at = time.time()
        self.save()

    def forget(self, query: str) -> bool:
        place = self.find(query)
        if place is None:
            return False
        for keyframe in place.keyframes:
            (self.root / keyframe).unlink(missing_ok=True)
        folder = self.images / place.id
        if folder.is_dir() and not any(folder.iterdir()):
            folder.rmdir()
        del self.places[place.id]
        self.save()
        return True

    def keyframe_bytes(self, place: Place, limit: int = 3) -> list[bytes]:
        """The most recent keyframes, for showing the model what to look for."""
        frames: list[bytes] = []
        for relative in place.keyframes[-limit:]:
            path = self.root / relative
            if path.exists():
                frames.append(path.read_bytes())
        return frames
