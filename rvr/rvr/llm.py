"""Which model to call, and where to call it.

Two things this has to get right.

**Manual driving must work with no credentials at all.** The rover is still a
rover when the network is down or no key is configured, so the client is built
defensively and every caller checks for ``None`` rather than letting a missing
key take the whole control stack down at startup.

**Any Anthropic-compatible endpoint should work**, not just Anthropic's own. A
gateway (Vercel AI Gateway, a corporate proxy) speaks the same Messages API at a
different address, so `base_url` is a first-class setting rather than something
you monkey-patch. Note that gateways usually namespace model ids by provider —
`anthropic/claude-sonnet-5`, not `claude-sonnet-5` — and getting that wrong
fails at the first request, so :func:`check_models` warns up front instead.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

import anthropic

log = logging.getLogger(__name__)

# Sonnet 5 for the control loop: this is a perceive-act cycle where a second of
# extra latency is a second of the rover sitting still, and the reasoning per
# step is modest. Set model: claude-opus-5 for missions that need deeper
# planning and can afford the slower loop.
DEFAULT_MODEL = "claude-sonnet-5"
# Routing one short utterance — fast matters far more than deep here.
DEFAULT_FAST_MODEL = "claude-haiku-4-5"
# Writing a place description from a handful of frames.
DEFAULT_DESCRIBE_MODEL = "claude-sonnet-5"

# Known gateways that namespace models by provider.
GATEWAY_HINTS = ("ai-gateway.vercel.sh", "openrouter.ai", "gateway")

NO_CLIENT = (
    "No API key is configured, so autonomy and voice commands are off. "
    "Manual driving still works. Set ANTHROPIC_API_KEY and restart."
)


@dataclass
class LLMConfig:
    """Everything about talking to a model, in one place."""

    api_key: str | None = None
    base_url: str | None = None
    """Override the API endpoint. Leave unset for Anthropic directly."""

    model: str = DEFAULT_MODEL
    fast_model: str = DEFAULT_FAST_MODEL
    describe_model: str = DEFAULT_DESCRIBE_MODEL
    max_steps: int = 60

    @property
    def via_gateway(self) -> bool:
        return bool(self.base_url) and any(h in self.base_url for h in GATEWAY_HINTS)

    def client(self) -> anthropic.AsyncAnthropic | None:
        return make_client(self.api_key, self.base_url)

    def check_models(self) -> list[str]:
        """Warn about model ids that will fail on the configured endpoint.

        A gateway rejects a bare `claude-sonnet-5` with a confusing 404 on the
        first mission, long after the mistake was made. Say so at startup.
        """
        problems: list[str] = []
        if not self.via_gateway:
            return problems
        for field_name in ("model", "fast_model", "describe_model"):
            value = getattr(self, field_name)
            if "/" not in value:
                problems.append(
                    f"{field_name}={value!r} has no provider prefix, but base_url "
                    f"points at a gateway. Gateways usually want 'anthropic/{value}'."
                )
        return problems


# Credential sources the SDK resolves on its own, beyond an explicit key. An
# unset ANTHROPIC_API_KEY does not mean there are no credentials.
_CREDENTIAL_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AI_GATEWAY_API_KEY",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
)
_PROFILE_DIR = Path.home() / ".config" / "anthropic"


def _has_credentials(client: anthropic.AsyncAnthropic) -> bool:
    """Is there anything for the SDK to authenticate with?

    Current SDK versions construct happily with no credentials and only fail at
    request time. Without this check the app would report autonomy as available
    and then die on an auth error during the first mission, which is a much
    worse way to learn you forgot to export a key.
    """
    if getattr(client, "api_key", None) or getattr(client, "auth_token", None):
        return True
    if any(os.environ.get(name) for name in _CREDENTIAL_ENV):
        return True
    # An `ant auth login` profile on disk works with a zero-arg client.
    return _PROFILE_DIR.is_dir() and any(_PROFILE_DIR.iterdir())


def make_client(
    api_key: str | None = None, base_url: str | None = None
) -> anthropic.AsyncAnthropic | None:
    """Return a client, or ``None`` if no credentials are available."""
    kwargs: dict = {}
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["base_url"] = base_url
    try:
        client = anthropic.AsyncAnthropic(**kwargs)
    except Exception as exc:  # noqa: BLE001 - older SDKs raise here instead
        log.warning("no API client (%s); autonomy and voice commands are disabled", exc)
        return None

    if not _has_credentials(client):
        log.warning("no credentials found; autonomy and voice commands are disabled")
        return None
    if base_url:
        log.info("using API endpoint %s", base_url)
    return client
