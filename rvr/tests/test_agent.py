"""Agent-loop tests against a scripted model.

No network. What is being checked is the plumbing that actually breaks in
practice: that the message history stays well-formed across tool rounds, that
every tool_use is answered, and that image context does not grow without bound
over a long mission.
"""

from __future__ import annotations

import asyncio
import types

import pytest

from rvr import protocol as p
from rvr.agent import MAX_IMAGES_IN_CONTEXT, AgentSession
from rvr.events import EventBus
from rvr.mission import MissionLog
from rvr.mock import build_mock
from rvr.rover import Rover, SafetyLimits
from rvr.semantic_map import SemanticMap
from rvr.tools import ToolContext


def _text(text):
    return types.SimpleNamespace(type="text", text=text)


def _tool(tool_id, name, args):
    return types.SimpleNamespace(type="tool_use", id=tool_id, name=name, input=args)


def _response(blocks, stop_reason="tool_use"):
    return types.SimpleNamespace(
        content=blocks,
        stop_reason=stop_reason,
        usage=types.SimpleNamespace(input_tokens=100, output_tokens=40),
    )


class ScriptedClient:
    """Stands in for anthropic.AsyncAnthropic, returning canned turns."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []
        self.messages = types.SimpleNamespace(create=self._create)

    async def _create(self, **kwargs):
        self.calls.append(kwargs)
        if not self.script:
            return _response([_text("done")], stop_reason="end_turn")
        return self.script.pop(0)


@pytest.fixture
async def session(tmp_path):
    _world, link, camera = build_mock()
    rover = Rover(link, camera, SafetyLimits())
    ctx = ToolContext(
        rover=rover, smap=SemanticMap(tmp_path), missions=MissionLog(tmp_path), bus=EventBus()
    )
    await rover.start()
    await asyncio.sleep(0.25)
    rover._on_telemetry(p.Telemetry(distance_cm=250.0, battery_v=7.9))
    try:
        yield AgentSession(ctx), ctx
    finally:
        await rover.stop()


async def test_a_full_mission_runs_to_completion(session):
    agent, ctx = session
    agent._client = ScriptedClient([
        _response([_text("Looking first."), _tool("t1", "look", {})]),
        _response([_tool("t2", "drive", {"direction": "forward", "speed": 50, "duration_ms": 300})]),
        _response([_tool("t3", "report_finding", {"text": "A purple shelf against the far wall.",
                                                  "importance": "notable"})]),
        _response([_tool("t4", "mission_complete", {"summary": "Explored and reported.",
                                                    "success": True})]),
    ])

    await agent.run("Explore and report anything notable.")

    assert agent.state.steps == 4
    assert ctx.missions.current is None, "mission_complete must close the mission"
    finished = ctx.missions.missions[-1]
    assert finished.status == "complete"
    assert len(finished.findings) == 1
    assert "purple shelf" in finished.findings[0].text
    assert finished.findings[0].image, "a finding must carry the frame it was made from"


async def test_message_history_stays_well_formed(session):
    """Roles must alternate and every tool_use must have a matching tool_result."""
    agent, _ctx = session
    agent._client = ScriptedClient([
        _response([_tool("t1", "sensors", {}), _tool("t2", "look", {})]),
        _response([_tool("t3", "mission_complete", {"summary": "done"})]),
    ])

    await agent.run("test")

    roles = [m["role"] for m in agent._messages]
    assert roles == ["user", "assistant", "user", "assistant", "user"], roles
    assert all(a != b for a, b in zip(roles, roles[1:])), "roles must alternate"

    requested, answered = set(), set()
    for message in agent._messages:
        for block in message["content"]:
            if getattr(block, "type", None) == "tool_use":
                requested.add(block.id)
            elif isinstance(block, dict) and block.get("type") == "tool_result":
                answered.add(block["tool_use_id"])
    assert requested == answered == {"t1", "t2", "t3"}


async def test_prose_without_a_tool_call_gets_one_nudge_then_ends(session):
    """A model that stops calling tools should not spin the loop to its budget."""
    agent, _ctx = session
    agent._client = ScriptedClient([
        _response([_text("I think I am finished.")], stop_reason="end_turn"),
        _response([_text("Yes, finished.")], stop_reason="end_turn"),
    ])

    await agent.run("test")
    assert agent.state.steps == 2


async def test_step_budget_is_enforced(session):
    agent, ctx = session
    agent.max_steps = 3
    agent._client = ScriptedClient(
        [_response([_tool(f"t{i}", "sensors", {})]) for i in range(10)]
    )

    result = await agent.run("go forever")

    assert agent.state.steps == 3
    assert "3 steps" in result
    assert ctx.missions.missions[-1].status == "aborted"


async def test_images_are_trimmed_so_context_stays_bounded(session):
    """Every frame is ~400 tokens; a 60-step mission would otherwise balloon."""
    agent, _ctx = session
    agent._client = ScriptedClient(
        [_response([_tool(f"t{i}", "look", {})]) for i in range(9)]
        + [_response([_tool("tz", "mission_complete", {"summary": "done"})])]
    )

    await agent.run("look repeatedly")

    images = 0
    for message in agent._messages:
        for block in message["content"]:
            if isinstance(block, dict):
                if block.get("type") == "image":
                    images += 1
                elif block.get("type") == "tool_result":
                    images += sum(
                        1 for inner in block["content"]
                        if isinstance(inner, dict) and inner.get("type") == "image"
                    )
    assert images <= MAX_IMAGES_IN_CONTEXT, f"{images} images left in context"


async def test_a_vetoed_drive_is_reported_as_such_to_the_model(session):
    """The model must never be told a motion happened when it did not."""
    agent, ctx = session
    ctx.rover._on_telemetry(p.Telemetry(distance_cm=4.0, battery_v=7.9))
    agent._client = ScriptedClient([
        _response([_tool("t1", "drive", {"direction": "forward", "speed": 80})]),
        _response([_tool("t2", "mission_complete", {"summary": "blocked"})]),
    ])

    await agent.run("drive into the wall")

    result = next(
        block
        for message in agent._messages
        for block in message["content"]
        if isinstance(block, dict) and block.get("type") == "tool_result"
        and block["tool_use_id"] == "t1"
    )
    assert "did not move" in result["content"][0]["text"]


async def test_no_api_key_fails_loudly_instead_of_silently(session):
    agent, _ctx = session
    agent._client = None
    result = await agent.run("go")
    assert "API key" in result
    assert agent.state.running is False
