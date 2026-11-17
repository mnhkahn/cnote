//! Anonymous SenseVoice transcription, matching cyeam_web/service/homework_reading.go.
use anyhow::{Context, Result, bail};
use reqwest::blocking::{Response, multipart};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read},
    time::{Duration, Instant},
};

const ENDPOINT: &str = "https://funaudiollm-sensevoice.hf.space";
const AUDIO_LIMIT: usize = 15 * 1024 * 1024;
const RESPONSE_LIMIT: u64 = 512 * 1024;

pub fn transcribe(bytes: Vec<u8>, mime: &str) -> Result<Value> {
    transcribe_at(ENDPOINT, bytes, mime)
}

fn checked(response: reqwest::Result<Response>) -> Result<Response> {
    let response =
        response.map_err(|_| anyhow::anyhow!("免费语音识别连接失败或等待超时，请稍后重试"))?;
    anyhow::ensure!(
        response.status() == reqwest::StatusCode::OK,
        "免费语音识别暂不可用（HTTP {}），请稍后重试",
        response.status().as_u16()
    );
    Ok(response)
}

fn read_json(response: Response) -> Result<Value> {
    let mut body = Vec::new();
    response
        .take(64 * 1024 + 1)
        .read_to_end(&mut body)
        .context("读取语音识别结果失败")?;
    anyhow::ensure!(body.len() <= 64 * 1024, "语音识别结果过大");
    serde_json::from_slice(&body).context("语音识别服务返回格式错误")
}

fn transcribe_at(endpoint: &str, bytes: Vec<u8>, mime: &str) -> Result<Value> {
    anyhow::ensure!(!bytes.is_empty(), "音频为空，无法转写");
    anyhow::ensure!(bytes.len() <= AUDIO_LIMIT, "音频超过 15 MB，无法转写");
    anyhow::ensure!(mime.starts_with("audio/"), "此附件不是音频");
    let mime = match mime {
        "audio/x-m4a" => "audio/mp4",
        "audio/x-wav" => "audio/wav",
        other => other,
    };
    let extension = match mime {
        "audio/mp4" => "m4a",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/webm" => "webm",
        "audio/aac" => "aac",
        "audio/opus" => "opus",
        "audio/flac" => "flac",
        "audio/amr" => "amr",
        "audio/3gpp" => "3gp",
        _ => "audio",
    };
    let filename = format!("audio.{extension}");
    let part = multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str(mime)?;
    // No Trello credentials, billing token, redirect, retry, or paid fallback.
    let client = crate::http::client()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let deadline = Instant::now() + Duration::from_secs(150);
    let remaining = || {
        deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1))
    };
    let uploaded = read_json(checked(
        client
            .post(format!("{endpoint}/gradio_api/upload"))
            .timeout(remaining())
            .multipart(multipart::Form::new().part("files", part))
            .send(),
    )?)?;
    let paths = uploaded
        .as_array()
        .context("免费语音识别未接受录音，请稍后重试")?;
    anyhow::ensure!(paths.len() == 1, "免费语音识别未接受录音，请稍后重试");
    let path = paths[0]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .context("免费语音识别未接受录音，请稍后重试")?;
    let job = read_json(checked(
        client
            .post(format!("{endpoint}/gradio_api/call/model_inference"))
            .timeout(remaining())
            .json(&json!({"data": [
                {"path": path, "orig_name": filename, "meta": {"_type": "gradio.FileData"}}, "en"
            ]}))
            .send(),
    )?)?;
    let id = job["event_id"].as_str().unwrap_or_default();
    anyhow::ensure!(
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "免费语音识别未创建任务，请稍后重试"
    );
    let response = checked(
        client
            .get(format!("{endpoint}/gradio_api/call/model_inference/{id}"))
            .timeout(remaining())
            .send(),
    )?;
    parse_events(response)
}

fn parse_events(reader: impl Read) -> Result<Value> {
    let mut reader = BufReader::new(reader.take(RESPONSE_LIMIT + 1));
    let mut total = 0;
    let mut event = String::new();
    let mut data = Vec::new();
    loop {
        let mut line = String::new();
        let count = reader
            .read_line(&mut line)
            .context("免费语音识别连接中断，请稍后重试")?;
        total += count;
        anyhow::ensure!(total as u64 <= RESPONSE_LIMIT, "语音识别结果过大");
        let line = line.trim_end_matches(['\r', '\n']);
        if let Some(value) = line.strip_prefix("event:") {
            event = value.trim().to_owned();
        }
        if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim().to_owned());
        }
        if line.is_empty() {
            match event.as_str() {
                "error" => bail!("免费语音识别额度不足或处理失败，请稍后重试"),
                "complete" => {
                    let result: Vec<String> = serde_json::from_str(&data.join("\n"))
                        .context("语音识别服务返回格式错误")?;
                    anyhow::ensure!(
                        result.len() == 1 && !result[0].trim().is_empty(),
                        "没有识别到清晰的英语语音，请检查录音"
                    );
                    return Ok(json!({"text": result[0].trim()}));
                }
                _ => {}
            }
            event.clear();
            data.clear();
        }
        if count == 0 {
            bail!("免费语音识别结果尚未返回或连接中断，请稍后重试");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_audio_before_connecting() {
        for (bytes, mime, expected) in [
            (vec![], "audio/wav", "音频为空"),
            (vec![0; AUDIO_LIMIT + 1], "audio/wav", "超过 15 MB"),
            (vec![1], "text/plain", "不是音频"),
        ] {
            assert!(
                transcribe_at("http://127.0.0.1:1", bytes, mime)
                    .unwrap_err()
                    .to_string()
                    .contains(expected)
            );
        }
    }

    #[test]
    fn uploads_and_queues_without_credentials_or_fallback() {
        for mode in ["success", "quota", "invalid-id", "error"] {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}", server.server_addr());
            let worker = std::thread::spawn(move || {
                let count = match mode {
                    "quota" => 1,
                    "invalid-id" => 2,
                    _ => 3,
                };
                for step in 0..count {
                    let mut request = server
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap()
                        .unwrap();
                    assert!(
                        !request
                            .headers()
                            .iter()
                            .any(|h| h.field.equiv("Authorization"))
                    );
                    let mut body = String::new();
                    request.as_reader().read_to_string(&mut body).unwrap();
                    let response = match step {
                        0 => {
                            assert_eq!(request.url(), "/gradio_api/upload");
                            assert!(body.contains("name=\"files\""));
                            assert!(body.contains("filename=\"audio.m4a\""));
                            assert!(body.contains("test recording"));
                            if mode == "quota" {
                                request
                                    .respond(
                                        tiny_http::Response::from_string("quota")
                                            .with_status_code(429),
                                    )
                                    .unwrap();
                                continue;
                            }
                            r#"["/tmp/gradio/audio.m4a"]"#
                        }
                        1 => {
                            assert_eq!(request.url(), "/gradio_api/call/model_inference");
                            let payload: Value = serde_json::from_str(&body).unwrap();
                            assert_eq!(
                                payload["data"],
                                json!([
                                    {"path":"/tmp/gradio/audio.m4a", "orig_name":"audio.m4a", "meta":{"_type":"gradio.FileData"}}, "en"
                                ])
                            );
                            if mode == "invalid-id" {
                                r#"{"event_id":"https://paid.example"}"#
                            } else {
                                r#"{"event_id":"job123"}"#
                            }
                        }
                        _ => {
                            assert_eq!(request.url(), "/gradio_api/call/model_inference/job123");
                            assert_eq!(request.method(), &tiny_http::Method::Get);
                            if mode == "error" {
                                "event: error\ndata: \"quota\"\n\n"
                            } else {
                                "event: heartbeat\ndata: null\n\nevent: complete\ndata: [\"hello\"]\n\n"
                            }
                        }
                    };
                    request
                        .respond(tiny_http::Response::from_string(response))
                        .unwrap();
                }
                // A failed request must not trigger an automatic retry or another endpoint.
                assert!(
                    server
                        .recv_timeout(Duration::from_millis(50))
                        .unwrap()
                        .is_none()
                );
            });
            let result = transcribe_at(&endpoint, b"test recording".to_vec(), "audio/x-m4a");
            worker.join().unwrap();
            if mode == "success" {
                assert_eq!(result.unwrap()["text"], "hello");
            } else {
                let message = result.unwrap_err().to_string();
                assert!(
                    message.contains(match mode {
                        "quota" => "HTTP 429",
                        "invalid-id" => "未创建任务",
                        _ => "额度不足或处理失败",
                    }),
                    "{message}"
                );
            }
        }
    }

    #[test]
    fn handles_streaming_results_and_failures() {
        for (events, expected) in [
            ("event: complete\ndata: invalid\n\n", "返回格式错误"),
            (
                "event: error\ndata: \"private upstream error\"\n\n",
                "额度不足或处理失败",
            ),
            ("event: complete\ndata: [\" \u{0020}\"]\n\n", "没有识别到"),
            ("event: heartbeat\ndata: null\n\n", "连接中断"),
        ] {
            assert!(
                parse_events(events.as_bytes())
                    .unwrap_err()
                    .to_string()
                    .contains(expected)
            );
        }
        assert_eq!(parse_events(b"event: heartbeat\r\ndata: null\r\n\r\nevent: complete\r\ndata: [\" hello <img src=x> \"]\r\n\r\n".as_slice()).unwrap()["text"], "hello <img src=x>");
    }
}
