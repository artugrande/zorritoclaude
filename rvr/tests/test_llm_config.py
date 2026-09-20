"""Endpoint and model-id configuration.

The failure this guards against is specific: point at a gateway, leave the model
ids unprefixed, and nothing complains until the first mission dies on a 404
twenty minutes into a drive.
"""

from __future__ import annotations

import pytest

from rvr.config import Config
from rvr.llm import LLMConfig


def test_defaults_target_anthropic_directly():
    llm = LLMConfig(api_key="k")
    assert llm.base_url is None
    assert llm.via_gateway is False
    assert llm.check_models() == []


def test_client_is_built_against_the_configured_endpoint():
    client = LLMConfig(api_key="k", base_url="https://ai-gateway.vercel.sh").client()
    assert client is not None
    assert "ai-gateway.vercel.sh" in str(client.base_url)


def test_client_uses_the_configured_key():
    assert LLMConfig(api_key="sk-test-123").client().api_key == "sk-test-123"


def test_gateway_is_detected_from_the_url():
    assert LLMConfig(base_url="https://ai-gateway.vercel.sh").via_gateway
    assert not LLMConfig(base_url="https://api.anthropic.com").via_gateway


def test_unprefixed_models_on_a_gateway_are_flagged():
    problems = LLMConfig(
        api_key="k", base_url="https://ai-gateway.vercel.sh", model="claude-sonnet-5"
    ).check_models()
    assert any("claude-sonnet-5" in p and "anthropic/" in p for p in problems)


def test_prefixed_models_on_a_gateway_pass():
    assert (
        LLMConfig(
            api_key="k",
            base_url="https://ai-gateway.vercel.sh",
            model="anthropic/claude-sonnet-5",
            fast_model="anthropic/claude-haiku-4-5",
            describe_model="anthropic/claude-sonnet-5",
        ).check_models()
        == []
    )


def test_all_three_models_are_checked():
    """The agent model is the obvious one; forgetting the other two is the bug."""
    problems = LLMConfig(
        api_key="k",
        base_url="https://ai-gateway.vercel.sh",
        model="anthropic/claude-sonnet-5",
    ).check_models()
    assert len(problems) == 2
    assert {"fast_model", "describe_model"} == {p.split("=")[0] for p in problems}


def test_prefixes_are_not_demanded_without_a_gateway():
    assert LLMConfig(api_key="k", model="claude-sonnet-5").check_models() == []


def test_config_yaml_round_trips_into_an_llm_config(tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(
        "base_url: https://ai-gateway.vercel.sh\n"
        "model: anthropic/claude-opus-5\n"
        "fast_model: anthropic/claude-haiku-4-5\n"
        "describe_model: anthropic/claude-sonnet-5\n"
        "max_steps: 25\n"
    )
    llm = Config.load(path).llm()
    assert llm.base_url == "https://ai-gateway.vercel.sh"
    assert llm.model == "anthropic/claude-opus-5"
    assert llm.max_steps == 25
    assert llm.check_models() == []


def test_gateway_key_env_var_is_accepted(tmp_path, monkeypatch):
    """Vercel calls its key AI_GATEWAY_API_KEY, not ANTHROPIC_API_KEY."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "vck_test")
    assert Config.load(tmp_path / "missing.yaml").api_key == "vck_test"


def test_anthropic_key_wins_over_gateway_key(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-direct")
    monkeypatch.setenv("AI_GATEWAY_API_KEY", "vck_test")
    assert Config.load(tmp_path / "missing.yaml").api_key == "sk-direct"


def test_base_url_env_var_is_used_when_the_file_is_silent(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://ai-gateway.vercel.sh")
    assert Config.load(tmp_path / "missing.yaml").base_url == "https://ai-gateway.vercel.sh"


def test_ambient_base_url_does_not_clobber_the_config_file(tmp_path, monkeypatch):
    """ANTHROPIC_BASE_URL is often set by a shell profile or a host environment.
    Silently overriding what the user wrote in config.yaml is a baffling bug."""
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
    path = tmp_path / "config.yaml"
    path.write_text("base_url: https://ai-gateway.vercel.sh\n")
    assert Config.load(path).base_url == "https://ai-gateway.vercel.sh"


def test_rvr_base_url_does_override_the_config_file(tmp_path, monkeypatch):
    monkeypatch.setenv("RVR_BASE_URL", "https://elsewhere.example")
    path = tmp_path / "config.yaml"
    path.write_text("base_url: https://ai-gateway.vercel.sh\n")
    assert Config.load(path).base_url == "https://elsewhere.example"


def test_no_credentials_yields_no_client(monkeypatch, tmp_path):
    """Manual driving has to survive this, so it must not raise."""
    for var in (
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AI_GATEWAY_API_KEY",
        "ANTHROPIC_PROFILE", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr("rvr.llm._PROFILE_DIR", tmp_path / "no-such-profile-dir")
    assert LLMConfig().client() is None


def test_agent_and_router_inherit_the_endpoint(tmp_path):
    """One config object must reach every model call, not just the agent."""
    from rvr.arbiter import Arbiter
    from rvr.events import EventBus
    from rvr.mission import MissionLog
    from rvr.mock import build_mock
    from rvr.rover import Rover
    from rvr.semantic_map import SemanticMap

    llm = LLMConfig(
        api_key="k",
        base_url="https://ai-gateway.vercel.sh",
        model="anthropic/claude-opus-5",
        fast_model="anthropic/claude-haiku-4-5",
    )
    _world, link, camera = build_mock()
    arbiter = Arbiter(
        Rover(link, camera), SemanticMap(tmp_path), MissionLog(tmp_path), EventBus(), llm=llm
    )

    assert arbiter.router.model == "anthropic/claude-haiku-4-5"
    assert "ai-gateway.vercel.sh" in str(arbiter.router._client.base_url)
    assert "ai-gateway.vercel.sh" in str(arbiter._client.base_url)


def test_state_reports_whether_autonomy_is_actually_available(tmp_path, monkeypatch):
    """A mic button that looks fine and silently does nothing is the worst
    possible way to communicate a missing key."""
    from rvr.arbiter import Arbiter
    from rvr.events import EventBus
    from rvr.mission import MissionLog
    from rvr.mock import build_mock
    from rvr.rover import Rover
    from rvr.semantic_map import SemanticMap

    def build(llm):
        _world, link, camera = build_mock()
        return Arbiter(
            Rover(link, camera), SemanticMap(tmp_path), MissionLog(tmp_path), EventBus(), llm=llm
        )

    with_key = build(LLMConfig(api_key="k")).state()
    assert with_key["llm_available"] is True
    assert with_key["llm_endpoint"] == "api.anthropic.com"

    for var in (
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AI_GATEWAY_API_KEY",
        "ANTHROPIC_PROFILE", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr("rvr.llm._PROFILE_DIR", tmp_path / "nope")
    assert build(LLMConfig()).state()["llm_available"] is False


def test_gateway_endpoint_is_reported_in_state(tmp_path):
    from rvr.arbiter import Arbiter
    from rvr.events import EventBus
    from rvr.mission import MissionLog
    from rvr.mock import build_mock
    from rvr.rover import Rover
    from rvr.semantic_map import SemanticMap

    _world, link, camera = build_mock()
    arbiter = Arbiter(
        Rover(link, camera), SemanticMap(tmp_path), MissionLog(tmp_path), EventBus(),
        llm=LLMConfig(api_key="k", base_url="https://ai-gateway.vercel.sh",
                      model="anthropic/claude-sonnet-5"),
    )
    assert arbiter.state()["llm_endpoint"] == "https://ai-gateway.vercel.sh"
    assert arbiter.state()["llm_model"] == "anthropic/claude-sonnet-5"
