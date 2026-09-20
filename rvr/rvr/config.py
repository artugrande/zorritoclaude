"""Configuration, from a YAML file with environment overrides."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import protocol as p
from .llm import DEFAULT_DESCRIBE_MODEL, DEFAULT_FAST_MODEL, DEFAULT_MODEL, LLMConfig
from .rover import SafetyLimits


@dataclass
class Config:
    rover_host: str = "192.168.4.1"
    """The rover's address. 192.168.4.1 is its own access point; in station mode
    it is whatever address your router hands it (the ESP32 reports it as StaIp
    in the handshake, and prints it over serial at boot)."""

    ws_port: int = p.WS_PORT
    camera_port: int = p.CAMERA_PORT

    bind_host: str = "127.0.0.1"
    bind_port: int = 8080

    model: str = DEFAULT_MODEL
    fast_model: str = DEFAULT_FAST_MODEL
    describe_model: str = DEFAULT_DESCRIBE_MODEL
    max_steps: int = 60
    api_key: str | None = None

    base_url: str | None = None
    """Point at any Anthropic-compatible endpoint instead of Anthropic directly
    (e.g. https://ai-gateway.vercel.sh). Gateways namespace model ids by
    provider, so set the model fields to 'anthropic/claude-sonnet-5' style too."""

    mock: bool = False
    data_dir: str = "data"
    log_level: str = "INFO"
    safety: SafetyLimits = field(default_factory=SafetyLimits)

    @classmethod
    def load(cls, path: str | Path | None = None, **overrides) -> "Config":
        data: dict = {}
        if path:
            path = Path(path)
            if path.exists():
                import yaml

                data = yaml.safe_load(path.read_text()) or {}

        safety_data = data.pop("safety", None) or {}

        # RVR_* variables are unambiguous intent for this app, so they override
        # the config file.
        overrides_env = {
            "rover_host": "RVR_HOST",
            "bind_host": "RVR_BIND_HOST",
            "bind_port": "RVR_BIND_PORT",
            "model": "RVR_MODEL",
            "fast_model": "RVR_FAST_MODEL",
            "describe_model": "RVR_DESCRIBE_MODEL",
            "base_url": "RVR_BASE_URL",
            "log_level": "RVR_LOG_LEVEL",
            "data_dir": "RVR_DATA_DIR",
        }
        for key, env in overrides_env.items():
            if os.environ.get(env):
                data[key] = os.environ[env]

        # Shared third-party variables are only FALLBACKS. They are often set
        # ambiently by a shell profile or a host environment, and silently
        # overriding a value the user wrote in config.yaml with one of those is
        # a genuinely baffling bug to chase.
        fallback_env = {
            "base_url": ("ANTHROPIC_BASE_URL",),
            # AI_GATEWAY_API_KEY is what Vercel names its key; accept both.
            "api_key": ("ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY"),
        }
        for key, names in fallback_env.items():
            if data.get(key):
                continue
            for env in names:
                if os.environ.get(env):
                    data[key] = os.environ[env]
                    break

        data.update({k: v for k, v in overrides.items() if v is not None})

        known = {f for f in cls.__dataclass_fields__ if f != "safety"}
        kwargs = {k: v for k, v in data.items() if k in known}
        for int_field in ("ws_port", "camera_port", "bind_port", "max_steps"):
            if int_field in kwargs:
                kwargs[int_field] = int(kwargs[int_field])

        limits = SafetyLimits(
            **{k: v for k, v in safety_data.items() if k in SafetyLimits.__dataclass_fields__}
        )
        return cls(safety=limits, **kwargs)

    def llm(self) -> LLMConfig:
        return LLMConfig(
            api_key=self.api_key,
            base_url=self.base_url,
            model=self.model,
            fast_model=self.fast_model,
            describe_model=self.describe_model,
            max_steps=self.max_steps,
        )

    def as_dict(self) -> dict:
        data = asdict(self)
        data["api_key"] = "***" if self.api_key else None
        return data
