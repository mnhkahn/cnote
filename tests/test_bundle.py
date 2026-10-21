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
    def test_versions(self):
        for tag in ['v1.2.3', 'V1.2.3', '1.2.3']:
            self.assertEqual(bundle.version_number(tag), '1.2.3')
        for tag in ['v01.2.3', '1.2', '1.2.3-beta', '../escape']:
            with self.assertRaises(ValueError):
                bundle.version_number(tag)

    def test_signed_feed_and_architecture(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'Info.plist'
            subprocess.run(['python3', str(ROOT / 'scripts/bundle-info.py'), '--version', 'v1.2.3', '--arch', 'arm64', '--output', str(path)], check=True, capture_output=True)
            info = plistlib.loads(path.read_bytes())
            self.assertEqual(info['CFBundleIdentifier'], 'com.cyeam.cnote')
            self.assertTrue(info['SURequireSignedFeed'])
            self.assertTrue(info['SUVerifyUpdateBeforeExtraction'])
            self.assertTrue(info['SUFeedURL'].endswith('/appcast-arm64.xml'))
            self.assertEqual(info['SUPublicEDKey'], (ROOT / 'assets/update-public-key.txt').read_text().strip())
