#!/usr/bin/env bash
# One command to get the control app running.
#
#   ./run.sh              -> simulator, no hardware needed
#   ./run.sh --real       -> connect to an actual rover (needs config.yaml)
#
# Creates a local virtualenv in .venv the first time, then reuses it.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python 3 is not installed, or not on PATH as '$PY'."
  echo "Install it from https://www.python.org/downloads/ and run this again."
  exit 1
fi

# The codebase uses `X | None` type syntax, which needs 3.10 or newer.
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Python 3.10+ is required. Found: $("$PY" --version)"
  echo "If you have a newer one installed, point at it: PYTHON=python3.12 ./run.sh"
  exit 1
fi

if [ ! -d .venv ]; then
  echo "First run: creating a virtualenv and installing dependencies…"
  "$PY" -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet -r requirements.txt
  echo "Done."
fi

MODE="--mock"
if [ "${1:-}" = "--real" ]; then
  MODE=""
  if [ ! -f config.yaml ]; then
    echo "No config.yaml yet — copying the example. Set rover_host in it, then rerun."
    cp config.example.yaml config.yaml
    exit 1
  fi
  shift
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo
  echo "  NOTE: ANTHROPIC_API_KEY is not set."
  echo "  Manual driving will work. Voice commands and autonomy will not."
  echo "  Get a key at https://console.anthropic.com/settings/keys then:"
  echo "      export ANTHROPIC_API_KEY=sk-ant-..."
  echo
fi

echo "Starting. Open http://127.0.0.1:8080 in Chrome."
echo "Press Ctrl+C to stop."
echo
exec ./.venv/bin/python -m rvr $MODE "$@"
