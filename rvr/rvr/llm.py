"""Building the Anthropic client without making it a hard dependency.

Manual driving and the reflex layer must work with no API key at all -- the
rover is still a rover when the network is down or the key is missing. So the
client is built defensively and every caller checks for ``None`` rather than
letting a missing key take the whole control stack down at startup.
"""

from __future__ import annotations

import logging

import anthropic

log = logging.getLogger(__name__)


def make_client(api_key: str | None = None) -> anthropic.AsyncAnthropic | None:
    """Return a client, or ``None`` if no credentials are available."""
    try:
        return anthropic.AsyncAnthropic(api_key=api_key) if api_key else anthropic.AsyncAnthropic()
    except Exception as exc:  # noqa: BLE001 - the SDK raises TypeError when unauthenticated
        log.warning("no Anthropic client (%s); autonomy and voice commands are disabled", exc)
        return None


NO_CLIENT = (
    "No Anthropic API key is configured, so autonomy and voice commands are off. "
    "Manual driving still works. Set ANTHROPIC_API_KEY and restart."
)
