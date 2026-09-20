"""Entry point: ``python -m rvr [--mock] [--host 10.0.0.42]``."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import sys

from .config import Config
from .server import serve


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rvr", description="Claude-driven Galaxy RVR control")
    parser.add_argument("-c", "--config", default="config.yaml")
    parser.add_argument("--host", help="rover address (overrides the config file)")
    parser.add_argument("--bind-host", help="address for the control UI")
    parser.add_argument("--bind-port", type=int, help="port for the control UI")
    parser.add_argument("--model", help="Anthropic model for the agent loop")
    parser.add_argument(
        "--mock",
        action="store_true",
        help="run against the built-in simulator instead of real hardware",
    )
    parser.add_argument("--log-level", default=None)
    args = parser.parse_args(argv)

    config = Config.load(
        args.config,
        rover_host=args.host,
        bind_host=args.bind_host,
        bind_port=args.bind_port,
        model=args.model,
        mock=args.mock or None,
        log_level=args.log_level,
    )
    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)-18s %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)

    if not config.mock and not config.api_key:
        import os

        if not os.environ.get("ANTHROPIC_API_KEY"):
            print(
                "ANTHROPIC_API_KEY is not set. Manual driving will work; voice "
                "commands and autonomy will not.",
                file=sys.stderr,
            )

    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(serve(config))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
