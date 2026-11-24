#!/usr/bin/env python3
"""Exercise the real GPUI → WKWebView → IPC → SQLite → graceful close path."""
import os
import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent
binary = root / 'target/debug/cnote'
if sys.argv[1:] == ['--settings']:
    for entry in ('menu', 'shortcut'):
        with tempfile.TemporaryDirectory(prefix='cnote-settings-smoke-') as folder:
            env = dict(os.environ, CNOTE_DATA_DIR=folder, CNOTE_SMOKE_TEST='1',
                       CNOTE_SETTINGS_SMOKE=entry)
            try:
                result = subprocess.run([str(binary)], env=env, capture_output=True, timeout=20)
            except subprocess.TimeoutExpired as error:
                raise SystemExit(f'Settings smoke test timed out ({entry}):\n{(error.stderr or b"").decode()}')
            if result.returncode:
                raise SystemExit(f'Settings smoke test failed ({entry}):\n{result.stderr.decode()}')
            with sqlite3.connect(pathlib.Path(folder) / 'notes.db') as connection:
                assert connection.execute("select value from settings where key='trello_refresh_minutes'").fetchone() == ('1',)
    print('CNote application menu and Command-comma both opened Settings and saved the selected interval.')
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix='cnote-native-smoke-') as folder:
    env = dict(os.environ, CNOTE_DATA_DIR=folder, CNOTE_SMOKE_TEST='1')
    result = subprocess.run([str(binary)], env=env, capture_output=True, text=True, timeout=60)
    if result.returncode or 'CNOTE_SMOKE_THEME_PREVIEW_OK' not in result.stderr or 'CNOTE_SMOKE_SAVED' not in result.stderr or 'CNOTE_SMOKE_ICONS_OK' not in result.stderr or 'CNOTE_SMOKE_WORKSPACES_OK' not in result.stderr or 'CNOTE_SMOKE_SHORTCUTS_OK' not in result.stderr or 'CNOTE_SMOKE_NAVIGATION_OK' not in result.stderr or 'CNOTE_SMOKE_NOTE_NAVIGATION_OK' not in result.stderr or 'CNOTE_SMOKE_TITLEBAR_OK' not in result.stderr:
        raise SystemExit(f'Native smoke test failed ({result.returncode}):\n{result.stderr}')
    with sqlite3.connect(pathlib.Path(folder) / 'notes.db') as connection:
        rows = connection.execute('select title,html,dirty from notes').fetchall()
        assert connection.execute("select value from settings where key='theme'").fetchone()[0] == 'dark'
        tool_state = json.loads(connection.execute("select value from settings where key='tool_state'").fetchone()[0])
    assert len(rows) == 1, rows
    assert rows[0][0] == 'Native smoke test', rows
    assert rows[0][1] == '<p>Native WebKit → IPC → SQLite ✓</p>', rows
    assert rows[0][2] == 1, rows
    assert '9007199254740993123' in tool_state['text'] and '\n' in tool_state['text'], tool_state
    assert tool_state['left'] == 'same\nold\n' and tool_state['right'] == 'same\nnew\n', tool_state
    assert tool_state['rows'] == [['name', 'n'], ['x', '10'], ['y', '2']], tool_state
    print('Native theme hover/cancel previews in both menu paths, titlebar layout, copied More-menu theme action, GPUI icon font/glyph resolution, real Cocoa Command 1–4 shortcuts, arrow navigation without text insertion, local workspace switching, WebKit startup, edit, durable save and graceful exit passed.')
