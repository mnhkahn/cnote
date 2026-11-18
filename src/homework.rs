//! The public Cyeam homework page's upload API. Never carries Trello credentials.
use anyhow::{Context, Result};
use reqwest::blocking::{Client, multipart};
use serde_json::Value;
use std::{io::Read, time::Duration};

#[path = "homework_image.rs"]
mod pencil_image;

fn client() -> Result<Client> {
    Ok(crate::http::client()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}
fn response(response: reqwest::blocking::Response) -> Result<Value> {
    let status = response.status();
    let mut bytes = Vec::new();
    response
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .context("读取批改结果失败")?;
    anyhow::ensure!(bytes.len() <= 4 * 1024 * 1024, "批改结果过大");
    let value: Value =
        serde_json::from_slice(&bytes).context("批改服务返回格式错误，请稍后重试")?;
    anyhow::ensure!(
        status.is_success(),
        "批改失败：{}",
        value["error"]
            .as_str()
            .unwrap_or("服务暂时不可用，请稍后重试")
    );
    anyhow::ensure!(
        value["report"].is_object() && value["input"].is_object(),
        "批改服务未返回结果"
    );
    Ok(value)
}
pub fn review(v: &Value, bytes: Vec<u8>, mime: &str) -> Result<Value> {
    review_at("https://www.cyeam.com", v, bytes, mime)
}
fn review_at(base: &str, v: &Value, bytes: Vec<u8>, mime: &str) -> Result<Value> {
    review_uploads_at(base, v, vec![(bytes, mime.to_owned())])
}
pub fn review_images(v: &Value, uploads: Vec<(Vec<u8>, String)>) -> Result<Value> {
    review_uploads_at("https://www.cyeam.com", v, uploads)
}
fn review_uploads_at(base: &str, v: &Value, uploads: Vec<(Vec<u8>, String)>) -> Result<Value> {
    let kind = v["kind"].as_str().unwrap_or_default();
    anyhow::ensure!(
        matches!(kind, "arithmetic" | "dictation" | "reading"),
        "不支持此作业类型"
    );
    let reading = kind == "reading";
    anyhow::ensure!(
        !uploads.is_empty() && uploads.len() <= if reading { 1 } else { 2 },
        "请提交1至2张作业图片或一段录音"
    );
    let mut form = multipart::Form::new().text("kind", kind.to_owned());
    match kind {
        "arithmetic" => {
            let count = v["count"]
                .as_u64()
                .filter(|n| (1..=100).contains(n))
                .context("请填写本次应完成题数（1～100）")?;
            form = form.text("count", count.to_string());
        }
        "dictation" | "reading" => {
            let field = if reading { "reference" } else { "words" };
            let text = v[field].as_str().unwrap_or_default().trim();
            anyhow::ensure!(
                !text.is_empty() && text.len() <= if reading { 30000 } else { 15000 },
                "请补全有效的词表或英文原文"
            );
            form = form.text(field, text.to_owned());
        }
        _ => unreachable!(),
    }
    for (index, (bytes, mime)) in uploads.into_iter().enumerate() {
        let mime = mime.as_str();
        anyhow::ensure!(
            !bytes.is_empty() && bytes.len() <= if reading { 15 } else { 10 } * 1024 * 1024,
            "附件为空或超过批改上限（图片10MB，录音15MB）"
        );
        let mime = match mime {
            "audio/x-m4a" => "audio/mp4",
            "audio/x-wav" => "audio/wav",
            other => other,
        };
        let extension = match mime {
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "image/webp" => "webp",
            "audio/mp4" => "m4a",
            "audio/mpeg" => "mp3",
            "audio/wav" => "wav",
            "audio/webm" => "webm",
            "audio/ogg" => "ogg",
            "audio/aac" => "aac",
            "audio/flac" => "flac",
            "audio/amr" => "amr",
            "audio/3gpp" => "3gp",
            "audio/opus" => "opus",
            _ => anyhow::bail!("请使用JPG、PNG、WebP图片或支持的朗读录音"),
        };
        anyhow::ensure!(
            reading == mime.starts_with("audio/"),
            "附件与作业类型不匹配"
        );
        let (bytes, mime, extension) = if kind == "arithmetic" {
            (pencil_image::enhance(&bytes)?, "image/png", "png")
        } else {
            (bytes, mime, extension)
        };
        anyhow::ensure!(
            bytes.len() <= if reading { 15 } else { 10 } * 1024 * 1024,
            "处理后的作业附件过大"
        );
        let filename = if index == 0 {
            format!("homework.{extension}")
        } else {
            format!("homework-{}.{extension}", index + 1)
        };
        let part = multipart::Part::bytes(bytes)
            .file_name(filename)
            .mime_str(mime)?;
        form = form.part(if reading { "audio" } else { "image" }, part);
    }
    let endpoint = if reading { "reading" } else { "review" };
    response(
        client()?
            .post(format!("{base}/api/homework/{endpoint}"))
            .header("Accept", "application/json")
            .multipart(form)
            .send()
            .map_err(|_| anyhow::anyhow!("批改连接失败或超时，请重试"))?,
    )
}

/// Resolve old textbook links without executing downloaded JavaScript.
pub fn reading_source(link: &str) -> Result<Value> {
    let url = url::Url::parse("https://www.cyeam.com")?.join(link)?;
    anyhow::ensure!(
        url.scheme() == "https"
            && matches!(url.host_str(), Some("www.cyeam.com" | "cyeam.com"))
            && url.path() == "/ai/translate",
        "请填写英文原文或有效的课文链接"
    );
    let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
    if let Some(text) = query.get("text").filter(|s| !s.trim().is_empty()) {
        return Ok(serde_json::json!({"reference":text}));
    }
    let book = query
        .get("textbook")
        .and_then(|v| v.parse::<usize>().ok())
        .context("课文链接缺少教材编号")?;
    let article = query
        .get("article")
        .and_then(|v| v.parse::<usize>().ok())
        .context("课文链接缺少文章编号")?;
    let response = client()?
        .get("https://www.cyeam.com/static/js/translate-textbook.js")
        .send()
        .context("读取课文失败，请填写英文原文")?;
    anyhow::ensure!(
        response.status().is_success(),
        "读取课文失败，请填写英文原文"
    );
    let mut source = String::new();
    response.take(2 * 1024 * 1024).read_to_string(&mut source)?;
    let text = textbook_text(&source, book, article).context("未找到课文，请填写英文原文")?;
    Ok(serde_json::json!({"reference":text}))
}
fn textbook_text(source: &str, book: usize, article: usize) -> Option<&str> {
    let book = source.split("articles: [").skip(1).nth(book)?;
    book.split("text: `")
        .skip(1)
        .nth(article)?
        .split('`')
        .next()
        .filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_photo(shade: u8) -> Vec<u8> {
        let mut pixels = image::GrayImage::from_pixel(32, 32, image::Luma([220]));
        for y in 4..28 {
            pixels.get_pixel_mut(4 + u32::from(shade) % 24, y)[0] = shade;
        }
        let mut output = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageLuma8(pixels)
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        output.into_inner()
    }
    #[test]
    fn rejects_invalid_upload_before_network() {
        for v in [
            serde_json::json!({"kind":"normal"}),
            serde_json::json!({"kind":"arithmetic","count":0}),
            serde_json::json!({"kind":"reading","reference":""}),
        ] {
            assert!(review_at("http://127.0.0.1:1", &v, vec![1], "image/png").is_err());
        }
        assert!(
            review_at(
                "http://127.0.0.1:1",
                &serde_json::json!({"kind":"arithmetic","count":10}),
                vec![1],
                "audio/mp4"
            )
            .is_err()
        );
    }
    #[test]
    fn uploads_all_three_kinds_and_handles_errors() {
        for (kind, mime, field, endpoint) in [
            ("arithmetic", "image/png", "count", "/api/homework/review"),
            ("dictation", "image/png", "words", "/api/homework/review"),
            (
                "reading",
                "audio/x-m4a",
                "reference",
                "/api/homework/reading",
            ),
        ] {
            for status in [200, 503] {
                let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
                let base = format!("http://{}", server.server_addr());
                let worker = std::thread::spawn(move || {
                    let mut request = server
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap()
                        .unwrap();
                    assert_eq!(request.url(), endpoint);
                    assert!(
                        !request
                            .headers()
                            .iter()
                            .any(|h| h.field.equiv("Authorization"))
                    );
                    let mut body = Vec::new();
                    request.as_reader().read_to_end(&mut body).unwrap();
                    let body = String::from_utf8_lossy(&body);
                    assert!(body.contains(&format!("name=\"{field}\"")));
                    assert!(body.contains(if kind == "reading" {
                        "name=\"audio\""
                    } else {
                        "name=\"image\""
                    }));
                    if kind == "reading" {
                        assert!(body.contains("filename=\"homework.m4a\""));
                    }
                    let response = if status == 200 {
                        r#"{"input":{"kind":"test"},"report":{"grade":"优"}}"#
                    } else {
                        r#"{"error":"服务繁忙"}"#
                    };
                    request
                        .respond(
                            tiny_http::Response::from_string(response).with_status_code(status),
                        )
                        .unwrap();
                });
                let result = review_at(
                    &base,
                    &serde_json::json!({"kind":kind,"count":20,"words":"bus stop\ncamera","reference":"We read together."}),
                    if kind == "arithmetic" {
                        test_photo(190)
                    } else {
                        b"test upload".to_vec()
                    },
                    mime,
                );
                worker.join().unwrap();
                if status == 200 {
                    assert_eq!(result.unwrap()["report"]["grade"], "优");
                } else {
                    assert!(result.unwrap_err().to_string().contains("服务繁忙"));
                }
            }
        }
    }
    #[test]
    fn uploads_two_images_in_order() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let first = test_photo(190);
        let second = test_photo(180);
        let enhanced_first = pencil_image::enhance(&first).unwrap();
        let enhanced_second = pencil_image::enhance(&second).unwrap();
        let worker = std::thread::spawn(move || {
            let mut request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            let mut body = Vec::new();
            request.as_reader().read_to_end(&mut body).unwrap();
            let text = String::from_utf8_lossy(&body);
            assert_eq!(text.matches("name=\"image\"").count(), 2);
            let first_at = body
                .windows(enhanced_first.len())
                .position(|v| v == enhanced_first)
                .unwrap();
            let second_at = body
                .windows(enhanced_second.len())
                .position(|v| v == enhanced_second)
                .unwrap();
            assert!(first_at < second_at);
            assert!(text.contains("homework-2.png"));
            assert_eq!(text.matches("Content-Type: image/png").count(), 2);
            request
                .respond(tiny_http::Response::from_string(
                    r#"{"input":{},"report":{"total":10}}"#,
                ))
                .unwrap();
        });
        let result = review_uploads_at(
            &base,
            &serde_json::json!({"kind":"arithmetic","count":10}),
            vec![(first, "image/png".into()), (second, "image/png".into())],
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(result["report"]["total"], 10);
        assert!(
            review_uploads_at(
                "http://127.0.0.1:1",
                &serde_json::json!({"kind":"arithmetic","count":10}),
                vec![]
            )
            .is_err()
        );
    }

    #[test]
    fn reads_textbook_without_executing_source() {
        let source = "const books=[{articles: [{text: `First`}, {text: `Second`}]}, {articles: [{text: `Third`}]}];";
        assert_eq!(textbook_text(source, 0, 1), Some("Second"));
        assert_eq!(textbook_text(source, 1, 0), Some("Third"));
        assert_eq!(textbook_text(source, 0, 2), None);
    }
}
