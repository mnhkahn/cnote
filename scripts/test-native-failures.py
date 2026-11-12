"""Check native test exit paths without starting AppKit or WebKit UI."""

import os
from pathlib import Path
import subprocess
import sys


def main():
    binary = str(Path(sys.argv[1]).resolve())
    # Even an inherited UI opt-in must not activate a window in these modes.
    env = {**os.environ, "CNOTE_NATIVE_UI_TESTS": "1"}
    probes = [
        (["--no-ui"], 0, "matching passed"),
        (["--self-test-failure", "timeout"], 1, "intentional false predicate"),
        (["--self-test-failure", "check"], 1, "check failed: NO"),
        (["--self-test-failure", "javascript"], 1, "intentional JavaScript failure"),
        (["--self-test-failure", "exception"], 1, "intentional exception"),
    ]
    for args, expected_status, expected_message in probes:
        try:
            result = subprocess.run(
                [binary, *args], env=env, capture_output=True, text=True, timeout=5
            )
        except subprocess.TimeoutExpired:
            print(f"FAIL native exit probe {args}: process timed out", file=sys.stderr)
            return 1
        output = result.stdout + result.stderr
        if (
            result.returncode != expected_status
            or expected_message not in output
            or "STEP UI /" in output
        ):
            print(
                f"FAIL native exit probe {args}: expected exit {expected_status}, "
                f"got {result.returncode}\n{output}", file=sys.stderr
            )
            return 1
        print(f"Native exit probe {' '.join(args)}: exit {result.returncode}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
