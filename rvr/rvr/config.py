"""Configuration, from a YAML file with environment overrides."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import protocol as p
from .agent import DEFAULT_MODEL
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
    max_steps: int = 60
    api_key: str | None = None

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

        env_map = {
            "rover_host": "RVR_HOST",
            "bind_host": "RVR_BIND_HOST",
            "bind_port": "RVR_BIND_PORT",
            "model": "RVR_MODEL",
            "log_level": "RVR_LOG_LEVEL",
            "data_dir": "RVR_DATA_DIR",
        }
        for key, env in env_map.items():
            if os.environ.get(env):
                data[key] = os.environ[env]

        # ANTHROPIC_API_KEY is read by the SDK itself if we leave this None.
        if os.environ.get("ANTHROPIC_API_KEY"):
            data.setdefault("api_key", os.environ["ANTHROPIC_API_KEY"])

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

    def as_dict(self) -> dict:
        data = asdict(self)
        data["api_key"] = "***" if self.api_key else None
        return data
