"""The desktop control app: HTTP + websocket in front of the arbiter.

Serves the UI, rebroadcasts video, and exposes every control the operator has.
Video is rebroadcast rather than proxied per-tab: the ESP32 has one frame queue
and a handful of sockets, so N browser tabs must still mean one upstream
connection.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path

from aiohttp import WSMsgType, web

from .arbiter import Arbiter, Mode
from .config import Config
from .events import EventBus
from .mission import MissionLog
from .rover import Rover
from .semantic_map import SemanticMap

log = logging.getLogger(__name__)

UI_DIR = Path(__file__).resolve().parent.parent / "ui"
BOUNDARY = "rvrframe"
STATE_INTERVAL = 0.3


def _json(data, status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


async def _body(request: web.Request) -> dict:
    if not request.can_read_body:
        return {}
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        return {}


class ControlServer:
    def __init__(self, config: Config, arbiter: Arbiter, rover: Rover, bus: EventBus) -> None:
        self.config = config
        self.arbiter = arbiter
        self.rover = rover
        self.bus = bus
        self.app = web.Application()
        self._routes()

    def _routes(self) -> None:
        add = self.app.router.add_route
        self.app.router.add_get("/", self.index)
        self.app.router.add_get("/favicon.ico", self.favicon)
        self.app.router.add_get("/stream.mjpg", self.stream)
        self.app.router.add_get("/snapshot.jpg", self.snapshot)
        self.app.router.add_get("/ws", self.websocket)

        self.app.router.add_get("/api/state", self.get_state)
        self.app.router.add_get("/api/places", self.get_places)
        self.app.router.add_get("/api/report", self.get_report)
        add("POST", "/api/mode", self.post_mode)
        add("POST", "/api/drive", self.post_drive)
        add("POST", "/api/stop", self.post_stop)
        add("POST", "/api/utterance", self.post_utterance)
        add("POST", "/api/mission", self.post_mission)
        add("POST", "/api/abort", self.post_abort)
        add("POST", "/api/teach", self.post_teach)
        add("DELETE", "/api/places/{name}", self.delete_place)

        # Keyframes and finding photos, so the UI can show them.
        data_dir = Path(self.config.data_dir)
        for sub in ("places", "findings"):
            (data_dir / sub).mkdir(parents=True, exist_ok=True)
            self.app.router.add_static(f"/data/{sub}/", data_dir / sub)
        if UI_DIR.is_dir():
            self.app.router.add_static("/ui/", UI_DIR)

    # --- pages ---------------------------------------------------------------

    async def index(self, _request: web.Request) -> web.Response:
        page = UI_DIR / "index.html"
        if not page.exists():
            return web.Response(text="UI not found; expected ui/index.html", status=500)
        return web.Response(text=page.read_text(), content_type="text/html")

    async def favicon(self, _request: web.Request) -> web.Response:
        return web.Response(
            body=(
                b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
                b'<circle cx="8" cy="8" r="7" fill="#5aa9e6"/></svg>'
            ),
            content_type="image/svg+xml",
        )

    async def snapshot(self, _request: web.Request) -> web.Response:
        frame, _ = self.rover.camera.latest()
        if frame is None:
            return web.Response(status=503, text="no frame")
        return web.Response(body=frame, content_type="image/jpeg")

    async def stream(self, request: web.Request) -> web.StreamResponse:
        """Rebroadcast the latest frame as MJPEG, to as many tabs as want it."""
        response = web.StreamResponse(
            headers={
                "Content-Type": f"multipart/x-mixed-replace; boundary={BOUNDARY}",
                "Cache-Control": "no-store, no-cache, must-revalidate",
            }
        )
        await response.prepare(request)
        last_sent = 0.0
        try:
            while True:
                frame, stamp = self.rover.camera.latest()
                if frame is not None and stamp > last_sent:
                    last_sent = stamp
                    await response.write(
                        f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\n"
                        f"Content-Length: {len(frame)}\r\n\r\n".encode()
                        + frame
                        + b"\r\n"
                    )
                await asyncio.sleep(0.05)
        except (ConnectionResetError, asyncio.CancelledError):
            pass  # the tab closed; entirely normal
        return response

    # --- websocket -----------------------------------------------------------

    async def websocket(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)

        async with self.bus.subscribe() as queue:
            await ws.send_json({"kind": "state", "data": self.arbiter.state()})
            for event in self.bus.history[-40:]:
                await ws.send_json(event.as_dict())

            async def pump_events() -> None:
                while True:
                    event = await queue.get()
                    await ws.send_json(event.as_dict())

            async def pump_state() -> None:
                while True:
                    await asyncio.sleep(STATE_INTERVAL)
                    await ws.send_json({"kind": "state", "data": self.arbiter.state()})

            tasks = [asyncio.create_task(pump_events()), asyncio.create_task(pump_state())]
            try:
                async for msg in ws:
                    if msg.type == WSMsgType.TEXT:
                        await self._ws_command(msg.json())
                    elif msg.type == WSMsgType.ERROR:
                        break
            except Exception:  # noqa: BLE001
                log.debug("ui websocket closed", exc_info=True)
            finally:
                for task in tasks:
                    task.cancel()
                for task in tasks:
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
        return ws

    async def _ws_command(self, payload: dict) -> None:
        """Low-latency path for held keys; the REST API covers everything else."""
        action = payload.get("action")
        if action == "drive":
            await self.arbiter.manual_motors(
                int(payload.get("left", 0)),
                int(payload.get("right", 0)),
                int(payload.get("duration_ms", 350)),
            )
        elif action == "stop":
            self.arbiter.emergency_stop("ui")

    # --- api -----------------------------------------------------------------

    async def get_state(self, _request: web.Request) -> web.Response:
        return _json(self.arbiter.state())

    async def get_places(self, _request: web.Request) -> web.Response:
        return _json(
            {
                "places": [
                    {
                        "id": place.id,
                        "name": place.name,
                        "description": place.description,
                        "visits": place.visits,
                        "keyframes": [f"/data/{k}" for k in place.keyframes],
                        "approach_moves": len(place.approach),
                    }
                    for place in self.arbiter.smap.all()
                ]
            }
        )

    async def get_report(self, _request: web.Request) -> web.Response:
        missions = self.arbiter.missions
        mission = missions.current or (missions.missions[-1] if missions.missions else None)
        if mission is None:
            return _json({"report": "No missions yet."})
        return _json({"report": missions.report(mission), "mission": mission.as_dict()})

    async def post_mode(self, request: web.Request) -> web.Response:
        body = await _body(request)
        try:
            return _json(await self.arbiter.set_mode(Mode(body.get("mode", "manual"))))
        except ValueError:
            return _json({"error": f"unknown mode {body.get('mode')!r}"}, status=400)

    async def post_drive(self, request: web.Request) -> web.Response:
        body = await _body(request)
        if "left" in body or "right" in body:
            result = await self.arbiter.manual_motors(
                int(body.get("left", 0)),
                int(body.get("right", 0)),
                int(body.get("duration_ms", 400)),
            )
        else:
            result = await self.arbiter.manual_direction(
                str(body.get("direction", "forward")),
                int(body.get("speed", 55)),
                int(body.get("duration_ms", 500)),
            )
        return _json(result)

    async def post_stop(self, _request: web.Request) -> web.Response:
        self.arbiter.emergency_stop("ui")
        return _json({"ok": True})

    async def post_utterance(self, request: web.Request) -> web.Response:
        body = await _body(request)
        return _json(await self.arbiter.handle_utterance(str(body.get("text", ""))))

    async def post_mission(self, request: web.Request) -> web.Response:
        body = await _body(request)
        goal = str(body.get("goal", "")).strip()
        if not goal:
            return _json({"error": "a mission needs a goal"}, status=400)
        return _json(await self.arbiter.start_mission(goal))

    async def post_abort(self, _request: web.Request) -> web.Response:
        return _json(await self.arbiter.abort_mission("ui"))

    async def post_teach(self, request: web.Request) -> web.Response:
        body = await _body(request)
        return _json(
            await self.arbiter.teach_place(
                str(body.get("name", "")),
                str(body.get("description", "")),
                scan=bool(body.get("scan", True)),
            )
        )

    async def delete_place(self, request: web.Request) -> web.Response:
        name = request.match_info["name"]
        return _json({"ok": self.arbiter.smap.forget(name)})


async def build(config: Config) -> tuple[ControlServer, Rover, Arbiter]:
    """Wire everything together, real hardware or mock."""
    bus = EventBus()
    data_dir = Path(config.data_dir)
    smap = SemanticMap(data_dir)
    missions = MissionLog(data_dir)

    if config.mock:
        from .mock import build_mock

        _world, link, camera = build_mock()
        log.warning("running against the MOCK rover -- no hardware is involved")
    else:
        from .transport import CameraLink, RoverLink

        link = RoverLink(config.rover_host, config.ws_port)
        camera = CameraLink(config.rover_host, config.camera_port)

    rover = Rover(link, camera, config.safety)
    arbiter = Arbiter(rover, smap, missions, bus, llm=config.llm())
    return ControlServer(config, arbiter, rover, bus), rover, arbiter


async def serve(config: Config) -> None:
    server, rover, arbiter = await build(config)
    await rover.start()
    with contextlib.suppress(Exception):
        await rover.release_onboard_autonomy()

    runner = web.AppRunner(server.app)
    await runner.setup()
    site = web.TCPSite(runner, config.bind_host, config.bind_port)
    await site.start()
    log.info("control app on http://%s:%d", config.bind_host, config.bind_port)
    log.info("rover link %s | camera %s", rover.link.url, rover.camera.stream_url)

    try:
        await asyncio.Event().wait()
    finally:
        log.info("shutting down")
        await arbiter.abort_mission("shutdown")
        await rover.stop()
        await runner.cleanup()
