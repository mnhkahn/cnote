//! Portable naming and file saving for a day's submitted homework attachments.
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

fn ordinal(number: usize) -> String {
    let digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    match number {
        1..=9 => digits[number].into(),
        10 => "十".into(),
        11..=19 => format!("十{}", digits[number % 10]),
        20..=99 => format!(
            "{}十{}",
            digits[number / 10],
            if number.is_multiple_of(10) {
                ""
            } else {
                digits[number % 10]
            }
        ),
        _ => number.to_string(),
    }
}
fn title(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let value = value.trim().trim_matches('.');
    let mut name = String::new();
    for c in value.chars() {
        if name.len() + c.len_utf8() > 160 {
            break;
        }
        name.push(c);
    }
    if name.is_empty() {
        "作业".into()
    } else {
        name
    }
}
fn media(mime: &str) -> Option<(&'static str, &'static str)> {
    Some(match mime {
        "image/jpeg" => ("图", "jpg"),
        "image/png" => ("图", "png"),
        "image/webp" => ("图", "webp"),
        "image/gif" => ("图", "gif"),
        "image/avif" => ("图", "avif"),
        "image/bmp" => ("图", "bmp"),
        "image/heic" => ("图", "heic"),
        "image/heif" => ("图", "heif"),
        "image/tiff" => ("图", "tiff"),
        "audio/mpeg" => ("音频", "mp3"),
        "audio/mp4" | "audio/x-m4a" => ("音频", "m4a"),
        "audio/wav" | "audio/x-wav" => ("音频", "wav"),
        "audio/ogg" => ("音频", "ogg"),
        "audio/aac" => ("音频", "aac"),
        "audio/webm" => ("音频", "webm"),
        "audio/flac" => ("音频", "flac"),
        "audio/amr" => ("音频", "amr"),
        "audio/3gpp" => ("音频", "3gp"),
        "audio/opus" => ("音频", "opus"),
        _ => return None,
    })
}
pub(super) fn plan(name: &str, date: &str, attachments: &Value) -> Result<Value> {
    let parsed = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").context("作业日期无效")?;
    anyhow::ensure!(
        parsed.format("%Y-%m-%d").to_string() == date,
        "作业日期无效"
    );
    let mut attachments: Vec<_> = attachments
        .as_array()
        .context("附件列表格式错误")?
        .iter()
        .collect();
    // Trello provides the submission date; preserve original order for equal dates.
    attachments.sort_by_key(|a| a["date"].as_str().unwrap_or_default());
    let (mut images, mut audio) = (0, 0);
    let mut files = Vec::new();
    for attachment in attachments {
        if attachment["isUpload"] != true {
            continue;
        }
        let Some(mime) = super::preview_mime(attachment) else {
            continue;
        };
        let Some((kind, extension)) = media(mime) else {
            continue;
        };
        let id = super::identifier(attachment)?;
        let counter = if kind == "图" {
            &mut images
        } else {
            &mut audio
        };
        *counter += 1;
        files.push(json!({"id":id, "mime":mime, "name":format!("{date}_{}_{kind}{}.{extension}", title(name), ordinal(*counter))}));
    }
    Ok(json!({"files":files}))
}

/// Atomically reserve a new name, never overwrite another download.
pub fn save_file(directory: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    anyhow::ensure!(
        !name.is_empty()
            && name != "."
            && name != ".."
            && !name.chars().any(|c| c.is_control() || "/\\:".contains(c)),
        "下载文件名无效"
    );
    std::fs::create_dir_all(directory).context("无法创建下载目录")?;
    let base = Path::new(name);
    let stem = base
        .file_stem()
        .and_then(|s| s.to_str())
        .context("下载文件名无效")?;
    let extension = base
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    for suffix in 0..10_000 {
        let leaf = if suffix == 0 {
            name.to_owned()
        } else if extension.is_empty() {
            format!("{stem} ({suffix})")
        } else {
            format!("{stem} ({suffix}).{extension}")
        };
        let path = directory.join(leaf);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let result = file.write_all(bytes).and_then(|_| file.sync_all());
                if let Err(error) = result {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(error).context("附件保存失败，请检查下载目录权限和可用空间");
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).context("无法写入下载目录"),
        }
    }
    anyhow::bail!("下载目录同名文件过多")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_all_submissions_by_homework_date_title_and_media_order() {
        let attachments = json!([
            {"id":"bbbbbbbbbbbbbbbbbbbbbbbb","isUpload":true,"name":"uuid-2.PNG","date":"2026-11-18T11:00:00Z"},
            {"id":"aaaaaaaaaaaaaaaaaaaaaaaa","isUpload":true,"mimeType":"image/jpeg","name":"random.jpg","date":"2026-11-18T10:00:00Z"},
            {"id":"cccccccccccccccccccccccc","isUpload":true,"mimeType":"audio/mp4","date":"2026-11-18T12:00:00Z"},
            {"id":"dddddddddddddddddddddddd","isUpload":false,"mimeType":"image/jpeg"},
            {"id":"eeeeeeeeeeeeeeeeeeeeeeee","isUpload":true,"mimeType":"application/pdf"}
        ]);
        let files = plan("语文", "2026-11-18", &attachments).unwrap();
        let files = files["files"].as_array().unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(files[0]["name"], "2026-11-18_语文_图一.jpg");
        assert_eq!(files[1]["name"], "2026-11-18_语文_图二.png");
        assert_eq!(files[2]["name"], "2026-11-18_语文_音频一.m4a");
        assert!(plan("语文", "../../bad", &attachments).is_err());
        let unsafe_name = plan(
            &format!("../../{}", "语".repeat(200)),
            "2026-11-18",
            &attachments,
        )
        .unwrap();
        let name = unsafe_name["files"][0]["name"].as_str().unwrap();
        assert!(!name.contains('/'));
        assert!(name.len() < 240);
    }
    #[test]
    fn downloads_do_not_overwrite_existing_files_or_escape_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let first = save_file(dir.path(), "2026-11-18_语文_图一.jpg", b"original").unwrap();
        let second = save_file(dir.path(), "2026-11-18_语文_图一.jpg", b"second").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).unwrap(), b"original");
        assert_eq!(std::fs::read(second).unwrap(), b"second");
        assert!(save_file(dir.path(), "../escape.jpg", b"bad").is_err());
    }
}
