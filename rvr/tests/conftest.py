import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# The SDK refuses to construct a client with no credentials, and these tests
# never reach the network -- every model call is stubbed.
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key-not-used")
