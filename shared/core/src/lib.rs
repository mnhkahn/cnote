//! A native SDK over the desktop's canonical business modules: no GPUI, AppKit or Finder.
mod analytics;
#[path = "../../../src/asr.rs"]
pub mod asr;
#[path = "../../../src/cloud.rs"]
pub mod cloud;
pub mod credential_store;
#[path = "../../../src/engine.rs"]
pub mod engine;
#[path = "../../../src/homework.rs"]
pub mod homework;
#[path = "../../../src/link_metadata.rs"]
pub mod link_metadata;
#[path = "../../../src/note_title.rs"]
pub mod note_title;
#[path = "../../../src/ocr.rs"]
pub mod ocr;
pub mod platform;
#[path = "../../../src/store.rs"]
pub mod store;
mod theme;
#[path = "../../../src/trello.rs"]
pub mod trello;
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

pub struct Session {
    handle: engine::Handle,
    extra_tx: async_channel::Sender<Value>,
    extra: async_channel::Receiver<Value>,
}
impl Session {
    pub fn open(
        path: PathBuf,
        downloads: PathBuf,
        vault: Arc<dyn credential_store::Vault>,
    ) -> Result<Self> {
        std::fs::create_dir_all(path.parent().context("数据库目录无效")?)?;
        platform::set_downloads(downloads)?;
        credential_store::install(vault)?;
        let (extra_tx, extra) = async_channel::unbounded();
        Ok(Self {
            handle: engine::start(path),
            extra_tx,
            extra,
        })
    }
    pub fn dispatch(&self, raw: &str) -> Result<()> {
        anyhow::ensure!(raw.len() <= 40 * 1024 * 1024, "请求超过大小限制");
        let v: Value = serde_json::from_str(raw)?;
        match v["type"].as_str().context("请求缺少类型")? {
            "trello" => {
                let tx = self.extra_tx.clone();
                std::thread::spawn(move || {
                    let request = v["request"].clone();
                    if matches!(
                        v["op"].as_str(),
                        Some(
                            "copy_image"
                                | "download"
                                | "download_audio"
                                | "share_image"
                                | "recognize_image"
                        )
                    ) {
                        let result = trello::request(
                            json!({"op":"attachment","id":v["id"],"attachment":v["attachment"],"original":true}),
                        );
                        let event = match result {
                            Ok(data) => {
                                json!({"type":"trello_media","request":request,"op":v["op"],"name":v["name"],"data":data})
                            }
                            Err(e) => {
                                json!({"type":"trello","result":{"request":request,"error":e.to_string(),"code":trello::error_code(&e)}})
                            }
                        };
                        let _ = tx.send_blocking(event);
                        return;
                    }
                    let result = trello::request(v);
                    let result = match result {
                        Ok(data) => json!({"request":request,"data":data}),
                        Err(e) => {
                            json!({"request":request,"error":e.to_string(),"code":trello::error_code(&e)})
                        }
                    };
                    let _ = tx.send_blocking(json!({"type":"trello","result":result}));
                });
            }
            "link_metadata" => {
                let tx = self.extra_tx.clone();
                std::thread::spawn(move || {
                    let title = link_metadata::fetch_title(v["url"].as_str().unwrap_or_default())
                        .unwrap_or_default();
                    let _ = tx.send_blocking(
                        json!({"type":"link_metadata_result","token":v["token"],"title":title}),
                    );
                });
            }
            "finder" | "finder_setting" => anyhow::bail!("手机不提供磁盘挂载"),
            _ => self.handle.tx.send(engine::Command::Web(v))?,
        }
        Ok(())
    }
    pub fn poll(&self) -> Result<Value> {
        let mut result = Vec::new();
        // Bound each bridge batch; never serialize the complete notebook state on each keystroke.
        for _ in 0..16 {
            if let Ok(e) = self.handle.events.try_recv() {
                result.push(serde_json::to_value(e)?);
            } else {
                break;
            }
        }
        for _ in 0..8 {
            if let Ok(e) = self.extra.try_recv() {
                result.push(e);
            } else {
                break;
            }
        }
        result.extend(platform::drain());
        Ok(Value::Array(result))
    }
}

#[path = "../../../src/theme_preference.rs"]
mod theme_preference;

#[path = "../../../src/http.rs"]
pub mod http;
