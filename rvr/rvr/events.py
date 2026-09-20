"""A tiny fan-out bus so the UI, the mission log and the agent see the same story.

Subscribers get their own bounded queue. A browser tab that stops draining --
backgrounded, throttled, or just gone -- drops its oldest events instead of
growing without bound or blocking the control loop behind it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from typing import Any

log = logging.getLogger(__name__)

MAX_QUEUED_EVENTS = 200


@dataclass
class Event:
    kind: str
    """One of: mode, takeover, drive, say, finding, place, mission, state, error, log."""
    data: dict[str, Any] = field(default_factory=dict)
    at: float = field(default_factory=time.time)

    def as_dict(self) -> dict:
        return asdict(self)


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[Event]] = set()
        self.history: list[Event] = []

    def publish(self, kind: str, **data: Any) -> Event:
        event = Event(kind=kind, data=data)
        # Transient chatter would swamp the replay buffer a new tab receives.
        if kind not in ("state", "drive"):
            self.history.append(event)
            del self.history[:-MAX_QUEUED_EVENTS]
        for queue in list(self._subscribers):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)
        return event

    @contextlib.asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[Event]]:
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=MAX_QUEUED_EVENTS)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)
