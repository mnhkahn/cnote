use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
static DOWNLOADS: OnceLock<PathBuf> = OnceLock::new();
static EVENTS: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
pub fn set_downloads(path: PathBuf) -> Result<()> {
    std::fs::create_dir_all(&path)?;
    DOWNLOADS
        .set(path)
        .map_err(|_| anyhow::anyhow!("下载目录已初始化"))
}
pub fn downloads() -> Result<PathBuf> {
    DOWNLOADS.get().cloned().context("下载目录未初始化")
}
pub fn emit(event: Value) {
    EVENTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .push(event);
}
pub fn drain() -> Vec<Value> {
    std::mem::take(&mut *EVENTS.get_or_init(Default::default).lock().unwrap())
}

pub fn data() -> Result<PathBuf> {
    Ok(downloads()?
        .parent()
        .context("数据目录未初始化")?
        .join("shared-core"))
}
