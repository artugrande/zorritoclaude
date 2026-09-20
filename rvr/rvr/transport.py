"""Network transport to the rover: one websocket, one camera stream.

Two deliberate design choices here.

**A single upstream camera connection.** The ESP32's ``/capture`` and ``/mjpg``
handlers pull from the same frame queue on a httpd with a small socket budget,
so several consumers hitting the camera directly starve each other. Instead
:class:`CameraLink` holds exactly one MJPEG connection and everything else --
the agent, every browser tab -- reads the latest decoded frame from it.

**Reconnection is the normal case, not the error case.** A rover drives out of
wifi range, browns out under motor load, and gets dropped by the ESP32 after 3
seconds of silence. Both links reconnect on their own with backoff and report
status rather than raising into the control loop.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import aiohttp

from . import protocol as p

log = logging.getLogger(__name__)

TelemetryHandler = Callable[[p.Telemetry], None]

# The ESP32 hardcodes this in camera_server.cpp. We still prefer the boundary
# advertised in the response's Content-Type when there is one.
DEFAULT_BOUNDARY = b"123456789000000000000987654321"


@dataclass
class LinkStatus:
    connected: bool = False
    last_error: str | None = None
    connected_since: float | None = None
    info: dict = field(default_factory=dict)
    """The check_info handshake: Name, Type, Check, video, StaIp, VideoTemplate."""

    def as_dict(self) -> dict:
        uptime = None if self.connected_since is None else time.time() - self.connected_since
        return {
            "connected": self.connected,
            "last_error": self.last_error,
            "uptime_s": None if uptime is None else round(uptime, 1),
            "info": self.info,
        }


class RoverLink:
    """Websocket control channel to the ESP32-CAM bridge (port 30102).

    Sends framed binary command payloads and decodes framed binary telemetry.
    Keeps the connection alive with a text ``ping`` every second -- the ESP32
    disconnects any client silent for 3 seconds.
    """

    def __init__(
        self,
        host: str,
        port: int = p.WS_PORT,
        *,
        on_telemetry: TelemetryHandler | None = None,
        reconnect: bool = True,
    ) -> None:
        self.host = host
        self.port = port
        self.on_telemetry = on_telemetry
        self.reconnect = reconnect
        self.status = LinkStatus()

        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._tasks: list[asyncio.Task] = []
        self._send_lock = asyncio.Lock()
        self._stop = asyncio.Event()
        self._last_pong: float = 0.0

    @property
    def url(self) -> str:
        return f"ws://{self.host}:{self.port}"

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._ws.closed

    async def start(self) -> None:
        self._stop.clear()
        self._session = aiohttp.ClientSession()
        self._tasks.append(asyncio.create_task(self._run(), name="rover-link"))

    async def stop(self) -> None:
        self._stop.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        if self._session is not None:
            await self._session.close()
        self.status.connected = False

    async def send(self, payload: bytes) -> bool:
        """Frame and send a command payload. Returns False if the link is down.

        Callers treat a False as "the rover did not hear that" -- the safety
        layer relies on this to know a stop never landed.
        """
        ws = self._ws
        if ws is None or ws.closed:
            return False
        try:
            async with self._send_lock:
                await ws.send_bytes(p.encode_frame(payload))
            return True
        except (aiohttp.ClientError, ConnectionResetError, RuntimeError) as exc:
            log.warning("send failed: %s", exc)
            self.status.last_error = str(exc)
            return False

    async def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                await self._connect_once()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - any failure means retry
                self.status.last_error = f"{type(exc).__name__}: {exc}"
                log.warning("rover link error: %s", self.status.last_error)
            finally:
                self.status.connected = False
                self.status.connected_since = None
                self._ws = None

            if not self.reconnect or self._stop.is_set():
                return
            log.info("reconnecting to %s in %.0fs", self.url, backoff)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=backoff)
            backoff = min(backoff * 2, 15.0)

    async def _connect_once(self) -> None:
        assert self._session is not None
        log.info("connecting to %s", self.url)
        async with self._session.ws_connect(
            self.url, heartbeat=None, timeout=aiohttp.ClientWSTimeout(ws_close=10)
        ) as ws:
            self._ws = ws
            self.status.connected = True
            self.status.connected_since = time.time()
            self.status.last_error = None
            self._last_pong = time.time()
            log.info("rover link up")

            ping = asyncio.create_task(self._ping_loop(ws), name="rover-ping")
            try:
                await self._read_loop(ws)
            finally:
                ping.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await ping

    async def _ping_loop(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        """Text ``ping`` keeps PINGPONG_TIMEOUT from dropping us.

        This is separate from the rover's *data* timeout: 3s without any command
        makes the ESP32 emit [APPSTOP]. Motion commands are repeated by the
        control loop upstream; ping alone is not enough to hold a drive.
        """
        while not ws.closed:
            await asyncio.sleep(p.PING_INTERVAL)
            try:
                async with self._send_lock:
                    await ws.send_str("ping")
            except (aiohttp.ClientError, ConnectionResetError, RuntimeError):
                return
            # The ESP32 answers every ping; silence past the timeout means the
            # socket is a zombie and we are better off tearing it down.
            if time.time() - self._last_pong > p.PINGPONG_TIMEOUT * 2:
                log.warning("no pong in %.0fs, dropping link", time.time() - self._last_pong)
                await ws.close()
                return

    async def _read_loop(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                self._handle_binary(msg.data)
            elif msg.type == aiohttp.WSMsgType.TEXT:
                self._handle_text(msg.data)
            elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                break

    def _handle_text(self, text: str) -> None:
        if text.startswith("pong"):
            self._last_pong = time.time()
            return
        # The handshake the ESP32 sends on connect. StaIp tells us whether the
        # rover is on our LAN (station mode) rather than serving its own AP.
        try:
            info = json.loads(text)
        except json.JSONDecodeError:
            log.debug("unparsed text from rover: %r", text[:120])
            return
        if isinstance(info, dict) and "Check" in info:
            self.status.info = info
            log.info("rover handshake: %s", info)

    def _handle_binary(self, data: bytes) -> None:
        try:
            payload = p.decode_frame(data)
        except p.ProtocolError as exc:
            log.debug("dropping malformed telemetry frame: %s", exc)
            return
        telemetry = p.parse_telemetry(payload)
        if self.on_telemetry is not None:
            self.on_telemetry(telemetry)


class CameraLink:
    """Holds the one MJPEG connection and hands out the most recent frame.

    Consumers never touch the ESP32 directly. :meth:`latest` is the current
    JPEG, :meth:`wait_for_fresh` blocks for a frame newer than a given moment --
    which is what the agent wants after moving, so it never reasons about a
    photo taken before it drove.
    """

    def __init__(self, host: str, port: int = p.CAMERA_PORT) -> None:
        self.host = host
        self.port = port
        self.status = LinkStatus()

        self._frame: bytes | None = None
        self._frame_time: float = 0.0
        self._frame_count = 0
        self._new_frame = asyncio.Event()
        self._session: aiohttp.ClientSession | None = None
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    @property
    def stream_url(self) -> str:
        return f"http://{self.host}:{self.port}{p.STREAM_PATH}"

    @property
    def capture_url(self) -> str:
        return f"http://{self.host}:{self.port}{p.CAPTURE_PATH}"

    @property
    def fps(self) -> float:
        uptime = time.time() - (self.status.connected_since or time.time())
        return round(self._frame_count / uptime, 1) if uptime > 1 else 0.0

    async def start(self) -> None:
        self._stop.clear()
        self._session = aiohttp.ClientSession()
        self._task = asyncio.create_task(self._run(), name="camera-link")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        if self._session is not None:
            await self._session.close()
        self.status.connected = False

    def latest(self) -> tuple[bytes | None, float]:
        """The most recent JPEG and the wall-clock time it arrived."""
        return self._frame, self._frame_time

    async def wait_for_fresh(self, newer_than: float, timeout: float = 4.0) -> bytes | None:
        """Wait for a frame captured after ``newer_than``.

        Returns the stalest available frame rather than nothing on timeout --
        a slightly old photo beats blinding the agent entirely.
        """
        deadline = time.monotonic() + timeout
        while self._frame_time <= newer_than:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                log.debug("no fresh frame within %.1fs, returning last known", timeout)
                return self._frame
            self._new_frame.clear()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._new_frame.wait(), timeout=remaining)
        return self._frame

    def _publish(self, jpeg: bytes) -> None:
        self._frame = jpeg
        self._frame_time = time.time()
        self._frame_count += 1
        self._new_frame.set()

    async def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                await self._stream_once()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.status.last_error = f"{type(exc).__name__}: {exc}"
                log.warning("camera error: %s", self.status.last_error)
            finally:
                self.status.connected = False

            if self._stop.is_set():
                return
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=backoff)
            backoff = min(backoff * 2, 10.0)

    async def _stream_once(self) -> None:
        assert self._session is not None
        log.info("opening camera stream %s", self.stream_url)
        timeout = aiohttp.ClientTimeout(total=None, sock_read=15)
        async with self._session.get(self.stream_url, timeout=timeout) as resp:
            resp.raise_for_status()
            boundary = _boundary_from_content_type(resp.headers.get("Content-Type", ""))
            self.status.connected = True
            self.status.connected_since = time.time()
            self.status.last_error = None
            self._frame_count = 0
            log.info("camera stream up (boundary=%s)", boundary.decode())

            async for jpeg in _iter_mjpeg(resp.content, boundary):
                self._publish(jpeg)
                if self._stop.is_set():
                    return

    async def capture(self) -> bytes | None:
        """One-shot grab from ``/capture``.

        Only used when the stream is down -- normally :meth:`latest` is both
        fresher and cheaper, since the stream is already running.
        """
        if self._session is None:
            return None
        try:
            async with self._session.get(
                self.capture_url, timeout=aiohttp.ClientTimeout(total=8)
            ) as resp:
                resp.raise_for_status()
                jpeg = await resp.read()
                self._publish(jpeg)
                return jpeg
        except Exception as exc:  # noqa: BLE001
            log.warning("capture failed: %s", exc)
            return None


def _boundary_from_content_type(content_type: str) -> bytes:
    """Pull the multipart boundary out of a Content-Type header."""
    for part in content_type.split(";"):
        key, _, value = part.strip().partition("=")
        if key.strip().lower() == "boundary":
            return value.strip().strip('"').encode() or DEFAULT_BOUNDARY
    return DEFAULT_BOUNDARY


async def _iter_mjpeg(stream: aiohttp.StreamReader, boundary: bytes):
    """Yield JPEGs from a ``multipart/x-mixed-replace`` body.

    Prefers the part's ``Content-Length`` (the ESP32 always sends one) and falls
    back to scanning for the next boundary if it is missing, so a truncated or
    non-conforming part costs one frame instead of desynchronising the stream.
    """
    marker = b"--" + boundary
    buffer = bytearray()

    while True:
        # Find the start of the next part.
        while marker not in buffer:
            chunk = await stream.read(8192)
            if not chunk:
                return
            buffer += chunk
            if len(buffer) > 4 * 1024 * 1024:
                raise RuntimeError("no MJPEG boundary in 4MB; is this really a stream?")
        del buffer[: buffer.index(marker) + len(marker)]

        # Then the end of that part's headers.
        while b"\r\n\r\n" not in buffer:
            chunk = await stream.read(8192)
            if not chunk:
                return
            buffer += chunk
        header_end = buffer.index(b"\r\n\r\n") + 4
        headers = bytes(buffer[:header_end])
        del buffer[:header_end]

        length = _content_length(headers)
        if length is None:
            continue  # resync on the next boundary

        while len(buffer) < length:
            chunk = await stream.read(8192)
            if not chunk:
                return
            buffer += chunk

        jpeg = bytes(buffer[:length])
        del buffer[:length]
        if jpeg.startswith(b"\xff\xd8"):  # SOI; anything else is a desync
            yield jpeg


def _content_length(headers: bytes) -> int | None:
    for line in headers.split(b"\r\n"):
        key, _, value = line.partition(b":")
        if key.strip().lower() == b"content-length":
            try:
                return int(value.strip())
            except ValueError:
                return None
    return None
