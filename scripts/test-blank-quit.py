"""Exercise native quit with a blank embedded page in the real GPUI application."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='cnote-blank-quit-') as data:
    env = dict(os.environ, CNOTE_DATA_DIR=data, CNOTE_SMOKE_TEST='1', CNOTE_BLANK_QUIT_TEST='1')
    result = subprocess.run([str(root / 'target/debug/cnote')], env=env,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert 'CNOTE_SMOKE_READY' in result.stderr, result.stderr
    assert 'CNOTE_SMOKE_SAVED' in result.stderr, result.stderr
    print('Real GPUI blank page: native close, backend acknowledgement and process exit passed.')
