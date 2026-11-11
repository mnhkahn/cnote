//! Speech-to-text using the same service and limits as cyeam-cli.
use anyhow::{Context, Result};
use reqwest::blocking::{Client, multipart};
use serde_json::{Value, json};
use std::{io::Read, time::Duration};

const ENDPOINT: &str = "https://www.cyeam.com/api/speech-to-text";
const AUDIO_LIMIT: usize = 15 * 1024 * 1024;
const RESPONSE_LIMIT: u64 = 2 * 1024 * 1024;

pub fn transcribe(bytes: Vec<u8>, mime: &str) -> Result<Value> {
    transcribe_at(ENDPOINT, bytes, mime)
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
    let part = multipart::Part::bytes(bytes)
        .file_name(format!("audio.{extension}"))
        .mime_str(mime)?;
    // This client never carries Trello credentials or follows upload redirects.
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client
        .post(endpoint)
        .header("Accept", "application/json")
        .multipart(multipart::Form::new().part("audio", part))
        .send()
        .map_err(|_| anyhow::anyhow!("语音识别连接失败或超时，请重试"))?;
    let status = response.status();
    let mut body = Vec::new();
    response
        .take(RESPONSE_LIMIT + 1)
        .read_to_end(&mut body)
        .context("读取语音识别结果失败")?;
    anyhow::ensure!(body.len() as u64 <= RESPONSE_LIMIT, "语音识别结果过大");
    let result: Value = serde_json::from_slice(&body).context("语音识别服务返回格式错误")?;
    anyhow::ensure!(
        status.is_success(),
        "语音识别失败：{}",
        result["error"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()))
    );
    let text = result["text"].as_str().unwrap_or_default().trim();
    anyhow::ensure!(!text.is_empty(), "未识别到文本，请重试");
    Ok(json!({"text": text}))
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
    fn uploads_audio_and_handles_service_results() {
        use std::io::{BufRead, BufReader, Write};
        for (status, response, expected) in [
            (
                200,
                r#"{"text":"  hello <img src=x>  "}"#,
                "hello <img src=x>",
            ),
            (200, r#"{"text":" "}"#, "未识别到文本"),
            (503, r#"{"error":"暂不可用"}"#, "暂不可用"),
            (200, "invalid", "返回格式错误"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/asr", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    headers.push_str(&line);
                }
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                assert!(!headers.to_ascii_lowercase().contains("authorization:"));
                assert!(headers.contains("multipart/form-data"));
                let body = String::from_utf8_lossy(&body);
                assert!(body.contains("name=\"audio\""));
                assert!(body.contains("filename=\"audio.m4a\""));
                assert!(body.contains("audio/mp4"));
                assert!(body.contains("test recording"));
                write!(stream, "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            });
            let result = transcribe_at(&endpoint, b"test recording".to_vec(), "audio/x-m4a");
            server.join().unwrap();
            if status == 200 && expected.starts_with("hello") {
                assert_eq!(result.unwrap()["text"], expected);
            } else {
                assert!(result.unwrap_err().to_string().contains(expected));
            }
        }
    }
}
