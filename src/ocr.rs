//! On-device Apple Vision OCR, adapted from cyeam-cli's native bridge.
use anyhow::{Context, Result};
use serde_json::Value;

pub fn recognize(bytes: Vec<u8>) -> Result<Value> {
    anyhow::ensure!(!bytes.is_empty(), "图片为空，无法识别");
    anyhow::ensure!(bytes.len() <= 20 * 1024 * 1024, "图片超过 20 MB，无法识别");
    recognize_native(&bytes)
}

#[cfg(target_os = "macos")]
fn recognize_native(bytes: &[u8]) -> Result<Value> {
    use std::{
        io::Write,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    // A private temporary file avoids blocking on a full stdin pipe. It is
    // removed on every return path, and no attachment URL reaches the script.
    let mut image = tempfile::NamedTempFile::new().context("无法准备识别图片")?;
    image.write_all(bytes).context("无法写入识别图片")?;
    let output = tempfile::NamedTempFile::new().context("无法准备识别结果")?;
    let mut child = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", include_str!("ocr.js")])
        .arg(image.path())
        .stdin(Stdio::null())
        .stdout(output.reopen()?)
        .stderr(Stdio::null())
        .spawn()
        .context("无法启动图片识别")?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                anyhow::ensure!(status.success(), "图片识别失败，请确认图片格式后重试");
                break;
            }
            Ok(None) if start.elapsed() < Duration::from_secs(30) => {
                std::thread::sleep(Duration::from_millis(30));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::ensure!(result.is_ok(), "读取图片识别状态失败");
                anyhow::bail!("图片识别超时，请重试");
            }
        }
    }
    let data = std::fs::read(output.path()).context("无法读取识别结果")?;
    let result: Value = serde_json::from_slice(&data).context("图片识别结果格式错误")?;
    anyhow::ensure!(
        result["text"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty()),
        "未识别到文字，请换一张更清晰的图片"
    );
    Ok(result)
}

#[cfg(not(target_os = "macos"))]
fn recognize_native(_: &[u8]) -> Result<Value> {
    anyhow::bail!("图片文字识别目前需要 macOS");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_empty_and_oversized_images() {
        assert!(
            recognize(vec![])
                .unwrap_err()
                .to_string()
                .contains("图片为空")
        );
        assert!(
            recognize(vec![0; 20 * 1024 * 1024 + 1])
                .unwrap_err()
                .to_string()
                .contains("超过 20 MB")
        );
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn recognizes_real_image_and_rejects_invalid_data() {
        let result = recognize(include_bytes!("../tests/ocr-text.png").to_vec()).unwrap();
        let text = result["text"].as_str().unwrap();
        assert!(text.contains("CNote OCR 12345"), "{text}");
        assert!(recognize(b"invalid image".to_vec()).is_err());
    }
}
