import importlib.util
import pathlib
import plistlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('bundle', ROOT / 'scripts/bundle-info.py')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)

class BundleTests(unittest.TestCase):
    def repository(self, folder):
        root = pathlib.Path(folder)
        def git(*args):
            return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True, text=True)
        git('init', '--initial-branch=main')
        git('config', 'user.name', 'CNote test')
        git('config', 'user.email', 'test@example.invalid')
        (root / 'Cargo.toml').write_text('[package]\nname = "cnote"\nversion = "0.1.0"\n')
        git('add', 'Cargo.toml')
        git('commit', '-m', 'fixture')
        return root, git

    def test_versions(self):
        for tag in ['v1.2.3', 'V1.2.3', '1.2.3']:
            self.assertEqual(bundle.version_number(tag), '1.2.3')
        for tag in ['v01.2.3', '1.2', '1.2.3-beta', '../escape']:
            with self.assertRaises(ValueError):
                bundle.version_number(tag)

    def test_local_version_uses_reachable_tags_instead_of_future_cargo_version(self):
        with tempfile.TemporaryDirectory() as folder:
            root, git = self.repository(folder)
            for tag in ['v0.0.2', '0.0.3', 'V0.0.9', 'v0.0.10', 'v1.0.0-beta', 'unrelated']:
                git('tag', tag)
            git('checkout', '-b', 'future')
            git('commit', '--allow-empty', '-m', 'future release')
            git('tag', 'v9.0.0')
            git('checkout', 'main')
            self.assertEqual(bundle.resolve_version(root=root), '0.0.10')

    def test_missing_tags_require_an_explicit_version(self):
        with tempfile.TemporaryDirectory() as folder:
            root, _ = self.repository(folder)
            with self.assertRaisesRegex(ValueError, 'pass --version'):
                bundle.resolve_version(root=root)
            self.assertEqual(bundle.resolve_version('v0.0.2', root=root), '0.0.2')

    def test_signed_feed_and_architecture(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'Info.plist'
            subprocess.run(['python3', str(ROOT / 'scripts/bundle-info.py'), '--version', 'v1.2.3', '--arch', 'arm64', '--output', str(path)], check=True, capture_output=True)
            info = plistlib.loads(path.read_bytes())
            self.assertEqual(info['CFBundleIdentifier'], 'com.cyeam.cnote')
            self.assertEqual(info['CFBundleShortVersionString'], '1.2.3')
            self.assertEqual(info['CFBundleVersion'], '1.2.3')
            self.assertTrue(info['SURequireSignedFeed'])
            self.assertTrue(info['SUVerifyUpdateBeforeExtraction'])
            self.assertTrue(info['SUFeedURL'].endswith('/appcast-arm64.xml'))
            self.assertEqual(info['SUPublicEDKey'], (ROOT / 'assets/update-public-key.txt').read_text().strip())
