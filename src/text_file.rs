//! Local documents opened by Finder or a command-line path.
use anyhow::{Context, bail};
use std::{io::Read, path::PathBuf};

pub fn path(value: &str) -> Option<PathBuf> {
    let url = url::Url::parse(value).ok()?;
    (url.scheme() == "file")
        .then(|| url.to_file_path().ok())
        .flatten()
}

pub fn read(path: &std::path::Path) -> anyhow::Result<String> {
    const MAX: u64 = 8 * 1024 * 1024;
    let file = std::fs::File::open(path).context("无法打开文件")?;
    if !file.metadata()?.is_file() {
        bail!("请选择文本文件");
    }
    let mut bytes = Vec::new();
    file.take(MAX + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX {
        bail!("文本文件最大支持 8 MB");
    }
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        if bytes.len() % 2 != 0 {
            bail!("UTF-16 文件编码不完整");
        }
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        String::from_utf16(&units).context("无法解码 UTF-16 文本")?
    } else {
        String::from_utf8(
            bytes
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(&bytes)
                .to_vec(),
        )
        .context("请使用 UTF-8 或 UTF-16 编码的文本文件")?
    };
    if text.contains('\0') {
        bail!("文件包含二进制内容，无法作为文本打开");
    }
    Ok(text)
}

/// Offer file associations only after the packaged app's editor has started.
pub fn offer_defaults() {
    #[cfg(target_os = "macos")]
    unsafe {
        unsafe extern "C" {
            fn cnote_default_apps_offer();
        }
        cnote_default_apps_offer();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_urls_and_text_encodings() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("中文 空格.md");
        assert_eq!(
            path(url::Url::from_file_path(&file).unwrap().as_str()),
            Some(file.clone())
        );
        assert!(path("https://example.com/a.md").is_none());
        for bytes in [
            b"\xef\xbb\xbf# hello".to_vec(),
            vec![0xff, 0xfe, 0x23, 0, 0x20, 0, 0x60, 0x4f],
        ] {
            std::fs::write(&file, bytes).unwrap();
            assert!(read(&file).unwrap().starts_with('#'));
        }
        for bytes in [vec![0, 1, 2], vec![0xff, 0xfe, 0], vec![0xff]] {
            std::fs::write(&file, bytes).unwrap();
            assert!(read(&file).is_err());
        }
        assert!(read(dir.path()).is_err());
        std::fs::File::create(&file)
            .unwrap()
            .set_len(8 * 1024 * 1024 + 1)
            .unwrap();
        assert!(read(&file).is_err());
    }
}
