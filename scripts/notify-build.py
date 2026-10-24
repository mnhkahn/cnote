#!/usr/bin/env python3
"""Notify the shared Feishu bot after CI/release completion."""
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

WORKFLOWS = {"Build and test", "Release macOS packages"}


def notification(event):
    run = event.get("workflow_run", {})
    name, result = run.get("name"), run.get("conclusion")
    if event.get("action") != "completed" or name not in WORKFLOWS:
        return None
    release = name == "Release macOS packages"
    if result in {"failure", "timed_out"}:
        title = "CNote 发布失败" if release else "CNote 编译 / 测试失败"
        if result == "timed_out":
            title += "（超时）"
    elif release and result == "success":
        title = "CNote 新版本编译并发布成功"
    else:
        return None
    repository = event["repository"]
    lines = [title, f"流程：{name}", f"分支 / 标签：{run['head_branch']}",
             f"提交：{run['head_sha'][:7]}", f"运行次数：{run.get('run_attempt', 1)}"]
    if release and result == "success":
        tag = urllib.parse.quote(run["head_branch"], safe="")
        lines.append(f"下载地址：{repository['html_url']}/releases/tag/{tag}")
    lines.append(f"构建日志：{run['html_url']}")
    return {"msg_type": "text", "content": {"text": "\n".join(lines)}}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def send(event, webhook, opener=None):
    payload = notification(event)
    if payload is None:
        return False
    parsed = urllib.parse.urlsplit(webhook or "")
    if (parsed.scheme != "https" or parsed.hostname not in {"open.feishu.cn", "open.larksuite.com"}
            or not parsed.path.startswith("/open-apis/bot/v2/hook/")
            or not parsed.path.removeprefix("/open-apis/bot/v2/hook/")
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("请在 CNote 仓库配置 FEISHU_WEBHOOK_URL Secret，使用原有飞书群机器人的同一个 Webhook。")
    request = urllib.request.Request(webhook,
                                     data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    opener = opener or urllib.request.build_opener(NoRedirect()).open
    try:
        with opener(request, timeout=30) as response:
            body = json.load(response)
            if (response.status != 200 or not isinstance(body, dict)
                    or body.get("code", body.get("StatusCode")) != 0):
                raise ValueError("bot rejected notification")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        # Webhook URLs and bot responses can contain credentials. Do not log them.
        raise RuntimeError("飞书通知失败，请检查机器人设置或网络。") from None
    return True


def main():
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        sent = send(event, os.environ.get("FEISHU_WEBHOOK_URL"))
        print("飞书构建通知已发送。" if sent else "此次构建无需通知。")
    except (KeyError, OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
