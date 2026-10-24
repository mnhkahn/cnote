import importlib.util
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('signing', ROOT / 'scripts/code-signing.py')
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class CodeSigningTests(unittest.TestCase):
    def test_missing_identity_never_creates_a_replacement(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(signing, 'run') as run:
            directory = pathlib.Path(folder) / 'missing'
            with self.assertRaisesRegex(RuntimeError, 'Restore the original identity'):
                signing.configure(directory)
            self.assertFalse(directory.exists())
            run.assert_not_called()

    def test_mismatched_certificate_is_rejected_before_keychain_access(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(signing, 'run') as run:
            directory = pathlib.Path(folder)
            # A different DER certificate payload must not authorize secret import.
            (directory / 'certificate.pem').write_text('-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n')
            with self.assertRaisesRegex(RuntimeError, 'differs from the pinned'):
                signing.verify_pin(directory)
            with self.assertRaisesRegex(RuntimeError, 'differs from the pinned'):
                signing.configure(directory, upload=True)
            run.assert_not_called()

    def test_incomplete_backup_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = pathlib.Path(folder)
            (directory / 'certificate.pem').write_bytes(signing.PUBLIC_CERT.read_bytes())
            with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                signing.verify_pin(directory)

    def test_secret_values_are_not_in_failure_messages(self):
        secret = 'test-password-must-not-leak'
        result = subprocess.CompletedProcess([], 1, stdout=secret.encode(), stderr=secret.encode())
        with mock.patch.object(subprocess, 'run', return_value=result):
            with self.assertRaises(RuntimeError) as error:
                signing.run(['security', 'unlock-keychain', '-p', secret])
        self.assertNotIn(secret, str(error.exception))

    def test_ci_cleanup_is_unavailable_on_user_machine(self):
        with mock.patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}), mock.patch.object(signing, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'disposable'):
                signing.cleanup_ci(pathlib.Path('/must-not-delete'))
            run.assert_not_called()

    def test_timeout_does_not_expose_private_arguments_or_output(self):
        secret = 'test-password-must-not-leak'
        command = ['security', 'unlock-keychain', '-p', secret]
        expired = subprocess.TimeoutExpired(command, 30, output=secret.encode(), stderr=secret.encode())
        with mock.patch.object(subprocess, 'run', side_effect=expired):
            with self.assertRaisesRegex(RuntimeError, 'timed out after 30s') as error:
                signing.run(command, timeout=30)
        self.assertNotIn(secret, str(error.exception))
        self.assertTrue(error.exception.__suppress_context__)

    def test_cleanup_continues_after_timeout_and_removes_private_files(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = pathlib.Path(folder) / 'identity'
            directory.mkdir()
            (directory / 'certificate.pem').touch()
            (directory / 'identity.keychain-db').touch()
            (directory / 'password').write_text('fixture-password')
            def run(command, **kwargs):
                if command[0] == 'sudo':
                    raise subprocess.TimeoutExpired(command, 30)
                return subprocess.CompletedProcess(command, 0, stdout=b'', stderr=b'')
            with mock.patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), \
                    mock.patch.object(subprocess, 'run', side_effect=run) as execute:
                with self.assertRaisesRegex(RuntimeError, 'Signing cleanup failed'):
                    signing.cleanup_ci(directory)
            self.assertFalse(directory.exists())
            self.assertEqual(execute.call_count, 2)
            commands = [call.args[0] for call in execute.call_args_list]
            self.assertEqual(commands[0][:5], ['sudo', '-n', 'security', 'remove-trusted-cert', '-d'])
            self.assertEqual(commands[1][:2], ['security', 'delete-keychain'])
            for call in execute.call_args_list:
                self.assertEqual(call.kwargs['timeout'], 30)

    def test_cleanup_reports_command_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = pathlib.Path(folder) / 'identity'
            directory.mkdir()
            (directory / 'identity.keychain-db').touch()
            result = subprocess.CompletedProcess([], 1, stdout=b'', stderr=b'private output')
            with mock.patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}), \
                    mock.patch.object(subprocess, 'run', return_value=result):
                with self.assertRaisesRegex(RuntimeError, 'Signing cleanup failed') as error:
                    signing.cleanup_ci(directory)
            self.assertNotIn('private output', str(error.exception))
            self.assertFalse(directory.exists())

    def test_release_cannot_opt_into_ad_hoc_signing(self):
        result = subprocess.run(['sh', str(ROOT / 'scripts/package.sh'), 'release'],
                                env=dict(os.environ, CNOTE_ALLOW_ADHOC='1'), capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('development-only', result.stderr)

    def test_import_identity_matches_pinned_certificate_and_limits_trust_policy(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = pathlib.Path(folder)
            signing.write_private(directory / 'password', b'fixture-password')
            signing.write_private(directory / 'identity.p12', b'fixture-p12')
            (directory / 'certificate.pem').write_bytes(signing.PUBLIC_CERT.read_bytes())
            commands = []
            def run(args, **kwargs):
                commands.append([str(x) for x in args])
                if args[:2] == ['security', 'create-keychain']:
                    pathlib.Path(args[-1]).touch()
                return b''
            with mock.patch.object(signing, 'run', side_effect=run):
                signing.import_keychain(directory, ci=True)
            trust = next(command for command in commands if 'add-trusted-cert' in command)
            self.assertEqual(trust[:4], ['sudo', 'security', 'add-trusted-cert', '-d'])
            self.assertEqual(trust[trust.index('-p') + 1], 'codeSign')
            unlock = next(i for i, command in enumerate(commands) if 'unlock-keychain' in command)
            settings = next(i for i, command in enumerate(commands) if 'set-keychain-settings' in command)
            self.assertLess(unlock, settings)
            self.assertEqual(commands[-1][:2], ['security', 'lock-keychain'])
