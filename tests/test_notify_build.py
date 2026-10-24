import importlib.util
import io
import json
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('notify_build', ROOT / 'scripts/notify-build.py')
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)


class Response(io.BytesIO):
    status = 200


class NotifyBuildTests(unittest.TestCase):
    def event(self, name='Build and test', conclusion='failure'):
        return {'action': 'completed', 'repository': {'html_url': 'https://github.com/mnhkahn/cnote'},
                'workflow_run': {'name': name, 'conclusion': conclusion, 'head_branch': 'v0.0.9',
                                 'head_sha': 'abcdef0123456789', 'run_attempt': 2,
                                 'html_url': 'https://github.com/mnhkahn/cnote/actions/runs/123'}}

    def test_failures_include_original_run_link_and_rerun_number(self):
        for name in notify.WORKFLOWS:
            for result in ['failure', 'timed_out']:
                payload = notify.notification(self.event(name, result))
                text = payload['content']['text']
                self.assertIn('失败', text)
                self.assertIn('/actions/runs/123', text)
                self.assertIn('运行次数：2', text)
                self.assertNotIn('下载地址', text)

    def test_release_success_includes_download_link(self):
        payload = notify.notification(self.event('Release macOS packages', 'success'))
        self.assertIn('https://github.com/mnhkahn/cnote/releases/tag/v0.0.9', payload['content']['text'])

    def test_successful_ci_and_cancelled_runs_do_not_send(self):
        opener = Mock()
        for name, result in [('Build and test', 'success'), ('Build and test', 'cancelled'),
                             ('Release macOS packages', 'cancelled'), ('unrelated', 'failure')]:
            self.assertFalse(notify.send(self.event(name, result), None, opener))
        opener.assert_not_called()

    def test_sends_to_shared_bot_and_checks_api_result(self):
        webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-secret'
        for response in [{'code': 0}, {'StatusCode': 0}]:
            opener = Mock(return_value=Response(json.dumps(response).encode()))
            self.assertTrue(notify.send(self.event(), webhook, opener))
            request = opener.call_args.args[0]
            self.assertEqual(request.full_url, webhook)
            self.assertEqual(request.method, 'POST')
            self.assertEqual(json.loads(request.data)['msg_type'], 'text')
            self.assertEqual(opener.call_args.kwargs['timeout'], 30)
        opener = Mock(return_value=Response(b'{"code": 19024}'))
        with self.assertRaisesRegex(RuntimeError, '飞书通知失败'):
            notify.send(self.event(), webhook, opener)

    def test_network_errors_do_not_expose_webhook(self):
        webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-secret'
        opener = Mock(side_effect=urllib.error.URLError(webhook))
        with self.assertRaises(RuntimeError) as error:
            notify.send(self.event(), webhook, opener)
        self.assertNotIn('test-secret', str(error.exception))

    def test_missing_webhook_is_reported_without_network_request(self):
        opener = Mock()
        with self.assertRaisesRegex(ValueError, 'FEISHU_WEBHOOK_URL'):
            notify.send(self.event(), None, opener)
        opener.assert_not_called()
