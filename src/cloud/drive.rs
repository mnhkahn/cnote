//! File manager requests share the note sync worker's OAuth session.
use super::*;
use serde_json::{Value, json};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

const SELECT: &str = "id,name,size,folder,file,eTag,lastModifiedDateTime,parentReference";
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("文件请求缺少参数")
}
fn name(v: &Value) -> Result<&str> {
    let s = field(v, "name")?;
    anyhow::ensure!(
        s.len() <= 255
            && !s.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
            && s != "."
            && s != ".."
            && !s.ends_with(['.', ' ']),
        "文件名无效"
    );
    Ok(s)
}
fn local_name(s: &str) -> String {
    let s = s.replace(['/', '\\', ':', '\0'], "_");
    if s.is_empty() || s == "." || s == ".." {
        "OneDrive-file".into()
    } else {
        s
    }
}
fn item_path(id: &str) -> String {
    format!("/me/drive/items/{}", segment(id))
}
fn parent_path(v: &Value) -> String {
    v["parent"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(item_path)
        .unwrap_or_else(|| "/me/drive/root".into())
}
impl Cloud {
    fn drive_pages(&mut self, mut path: String) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        loop {
            let page: Value = checked(
                self.request(reqwest::Method::GET, &path)?
                    .send()
                    .map_err(|e| e.without_url())?,
            )?
            .json()
            .map_err(|e| e.without_url())?;
            for item in page["value"].as_array().context("文件列表格式无效")? {
                // Never forward download URLs or other access-bearing metadata to the webview.
                items.push(json!({"id":item["id"],"name":item["name"],"size":item["size"],"folder":item["folder"],"file":item["file"],"eTag":item["eTag"],"lastModifiedDateTime":item["lastModifiedDateTime"],"parentReference":item["parentReference"]}));
            }
            match page["@odata.nextLink"].as_str() {
                Some(next) => {
                    path = next
                        .strip_prefix(&format!("{GRAPH}/"))
                        .map(|s| format!("/{s}"))
                        .context("拒绝不可信分页地址")?
                }
                None => return Ok(items),
            }
        }
    }
    fn drive_meta(&mut self, path: &str) -> Result<Value> {
        Ok(checked(
            self.request(reqwest::Method::GET, &format!("{path}?$select={SELECT}"))?
                .send()
                .map_err(|e| e.without_url())?,
        )?
        .json()
        .map_err(|e| e.without_url())?)
    }
    fn drive_body(&mut self, id: &str) -> Result<Response> {
        checked(
            self.request(reqwest::Method::GET, &format!("{}/content", item_path(id)))?
                .timeout(Duration::from_secs(3600))
                .send()
                .map_err(|e| e.without_url())?,
        )
    }
    fn drive_download(&mut self, item: &Value, target: &Path, depth: usize) -> Result<()> {
        anyhow::ensure!(depth < 100, "目录层级超过 100 层");
        let id = field(item, "id")?;
        if item["folder"].is_object() {
            std::fs::create_dir(target)?;
            for child in self.drive_pages(format!(
                "{}/children?$select={SELECT}&$top=200",
                item_path(id)
            ))? {
                let child_path = target.join(local_name(field(&child, "name")?));
                self.drive_download(&child, &child_path, depth + 1)?;
            }
        } else {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)?;
            std::io::copy(&mut self.drive_body(id)?, &mut file)?;
            file.sync_all()?;
        }
        Ok(())
    }
    pub(super) fn drive_request(&mut self, v: &Value) -> Result<Value> {
        let op = field(v, "op")?;
        match op {
            "list" | "search" => {
                let parent = parent_path(v);
                let folder = self.drive_meta(&parent)?;
                let path = if op == "search" {
                    let query = field(v, "query")?.replace('\'', "''");
                    format!(
                        "{parent}/search(q='{}')?$select={SELECT}&$top=200",
                        segment(&query)
                    )
                } else {
                    format!("{parent}/children?$select={SELECT}&$top=200")
                };
                Ok(json!({"folder":folder,"items":self.drive_pages(path)?}))
            }
            "mkdir" => {
                checked(self.request(reqwest::Method::POST, &format!("{}/children", parent_path(v)))?.json(&json!({"name":name(v)?,"folder":{},"@microsoft.graph.conflictBehavior":"fail"})).send().map_err(|e| e.without_url())?)?;
                Ok(json!({"changed":true}))
            }
            "rename" | "move" | "delete" | "save" => {
                let path = item_path(field(v, "id")?);
                let etag = field(v, "etag").context("缺少文件版本，请刷新后重试")?;
                if op == "delete" {
                    checked(
                        self.request(reqwest::Method::DELETE, &path)?
                            .header("If-Match", etag)
                            .send()
                            .map_err(|e| e.without_url())?,
                    )?;
                } else if op == "save" {
                    let text = v["text"].as_str().context("缺少文本")?;
                    anyhow::ensure!(text.len() <= 2 * 1024 * 1024, "文本最大支持 2 MB");
                    checked(
                        self.request(reqwest::Method::PUT, &format!("{path}/content"))?
                            .header("If-Match", etag)
                            .header("Content-Type", "text/plain; charset=utf-8")
                            .body(text.to_owned())
                            .send()
                            .map_err(|e| e.without_url())?,
                    )?;
                } else {
                    let body = if op == "rename" {
                        json!({"name":name(v)?,"@microsoft.graph.conflictBehavior":"fail"})
                    } else {
                        let destination = v["destination"]
                            .as_str()
                            .context("缺少目标目录")?
                            .trim_matches('/');
                        let dest = if destination.is_empty() {
                            "/me/drive/root".into()
                        } else {
                            format!(
                                "/me/drive/root:/{}",
                                destination
                                    .split('/')
                                    .map(segment)
                                    .collect::<Vec<_>>()
                                    .join("/")
                            )
                        };
                        let folder = self.drive_meta(&dest)?;
                        anyhow::ensure!(folder["folder"].is_object(), "目标不是文件夹");
                        json!({"parentReference":{"id":folder["id"]},"@microsoft.graph.conflictBehavior":"fail"})
                    };
                    checked(
                        self.request(reqwest::Method::PATCH, &path)?
                            .header("If-Match", etag)
                            .json(&body)
                            .send()
                            .map_err(|e| e.without_url())?,
                    )?;
                }
                Ok(json!({"changed":true}))
            }
            "upload" => {
                use base64::Engine;
                let data = v["data"].as_str().context("缺少文件内容")?;
                anyhow::ensure!(data.len() <= 28 * 1024 * 1024, "上传最大支持 20 MB");
                let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
                anyhow::ensure!(bytes.len() <= 20 * 1024 * 1024, "上传最大支持 20 MB");
                checked(
                    self.request(
                        reqwest::Method::PUT,
                        &format!(
                            "{}:/{}:/content?@microsoft.graph.conflictBehavior=fail",
                            parent_path(v),
                            segment(name(v)?)
                        ),
                    )?
                    .timeout(Duration::from_secs(300))
                    .header("Content-Type", "application/octet-stream")
                    .body(bytes)
                    .send()
                    .map_err(|e| e.without_url())?,
                )?;
                Ok(json!({"changed":true}))
            }
            "read" => {
                let id = field(v, "id")?;
                let item = self.drive_meta(&item_path(id))?;
                anyhow::ensure!(
                    item["folder"].is_null()
                        && item["size"].as_u64().unwrap_or(u64::MAX) <= 2 * 1024 * 1024,
                    "仅支持预览和编辑 2 MB 以内的 UTF-8 文本"
                );
                let mut bytes = Vec::new();
                self.drive_body(id)?
                    .take(2 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                anyhow::ensure!(bytes.len() <= 2 * 1024 * 1024, "文本超过 2 MB");
                let after = self.drive_meta(&item_path(id))?;
                anyhow::ensure!(item["eTag"] == after["eTag"], "文件已变化，请重新打开");
                let text =
                    String::from_utf8(bytes).context("该文件不是 UTF-8 文本，请下载后查看")?;
                anyhow::ensure!(!text.contains('\0'), "该文件不是文本，请下载后查看");
                Ok(json!({"item":after,"text":text}))
            }
            "download" => {
                let ids = v["ids"].as_array().context("请选择文件")?;
                anyhow::ensure!(!ids.is_empty() && ids.len() <= 500, "一次最多下载 500 项");
                let downloads = directories::UserDirs::new()
                    .and_then(|d| d.download_dir().map(PathBuf::from))
                    .context("找不到下载目录")?;
                std::fs::create_dir_all(&downloads)?;
                let staging = tempfile::Builder::new()
                    .prefix(".cnote-download-")
                    .tempdir_in(&downloads)?;
                let mut names = Vec::new();
                for id in ids {
                    let item = self.drive_meta(&item_path(id.as_str().context("文件 ID 无效")?))?;
                    let base = local_name(field(&item, "name")?);
                    let mut name = base.clone();
                    for number in 1.. {
                        if !names.contains(&name) {
                            break;
                        }
                        name = format!("{number}-{base}");
                    }
                    self.drive_download(&item, &staging.path().join(&name), 0)?;
                    names.push(name);
                }
                // Keep one unique download batch, preserving names and never overwriting local files.
                let target = downloads.join(format!("OneDrive-{}", uuid::Uuid::new_v4()));
                std::fs::rename(staging.path(), &target)?;
                Ok(
                    json!({"paths":names.iter().map(|n| target.join(n)).collect::<Vec<_>>(),"directory":target,"copy":v["copy"] == true,"open":v["open"] == true}),
                )
            }
            _ => bail!("不支持的文件操作"),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_and_names_are_confined() {
        for bad in ["..", ".", "a/b", "a\\b", "x:", "x ", "x."] {
            assert!(name(&json!({"name":bad})).is_err());
        }
        assert_eq!(name(&json!({"name":"作业.txt"})).unwrap(), "作业.txt");
        assert_eq!(local_name("../a:b"), ".._a_b");
        assert_eq!(
            parent_path(&json!({"parent":"a/b"})),
            "/me/drive/items/a%2Fb"
        );
    }
}
