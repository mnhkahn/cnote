use super::*;
use reqwest::Method;
fn path(value: &str) -> String {
    if value.is_empty() {
        "/me/drive/root".into()
    } else {
        format!(
            "/me/drive/root:/{}",
            value.split('/').map(segment).collect::<Vec<_>>().join("/")
        )
    }
}
fn checked_dav(response: Response) -> DavResult<Response> {
    let code = response.status().as_u16();
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(Failure(
            match code {
                400 | 403 | 404 | 409 | 412 | 423 => code,
                401 | 429 => 503,
                _ => 502,
            },
            "OneDrive request failed; refresh the folder and retry",
        ))
    }
}
pub(super) struct GraphDrive {
    pub(super) cloud: Cloud,
    pub(super) account: String,
    pub(super) metadata_directory: PathBuf,
}
impl GraphDrive {
    fn send(&mut self, method: Method, path: &str) -> DavResult<reqwest::blocking::RequestBuilder> {
        self.cloud.request(method, path).map_err(Into::into)
    }
    fn metadata_request(&mut self, value: &str) -> DavResult<Value> {
        checked_dav(
            self.send(
                Method::GET,
                &format!(
                    "{}?$select=id,name,size,folder,file,eTag,lastModifiedDateTime,parentReference",
                    path(value)
                ),
            )?
            .send()
            .map_err(|e| anyhow!(e.without_url()))?,
        )?
        .json()
        .map_err(|_| Failure(502, "Invalid cloud metadata"))
    }
}
impl Drive for GraphDrive {
    fn authorized(&mut self) -> bool {
        let Ok(Some(serialized)) = crate::credential_store::get("onedrive-oauth") else {
            return false;
        };
        let Ok(tokens) = serde_json::from_str::<Tokens>(&serialized) else {
            return false;
        };
        if self
            .cloud
            .tokens
            .as_ref()
            .is_some_and(|old| old.access_token == tokens.access_token)
        {
            return true;
        }
        let previous = self.cloud.tokens.replace(tokens);
        let allowed = matches!(self.cloud.account(),Ok(Reply::Account{id,..}) if id==self.account);
        if !allowed {
            self.cloud.tokens = previous;
        }
        allowed
    }
    fn metadata(&mut self, value: &str) -> DavResult<Value> {
        if auxiliary(value) {
            return self.local_metadata(value);
        }
        self.metadata_request(value)
    }
    fn children(&mut self, value: &str) -> DavResult<Vec<Value>> {
        if auxiliary(value) {
            return Ok(Vec::new());
        }
        let mut next = if value.is_empty() {
            "/me/drive/root/children?$select=id,name,size,folder,file,eTag,lastModifiedDateTime&$top=200".into()
        } else {
            format!(
                "{}:/children?$select=id,name,size,folder,file,eTag,lastModifiedDateTime&$top=200",
                path(value)
            )
        };
        let mut items = Vec::new();
        loop {
            let response: Value = checked_dav(
                self.send(Method::GET, &next)?
                    .send()
                    .map_err(|e| anyhow!(e.without_url()))?,
            )?
            .json()
            .map_err(|_| Failure(502, "Invalid directory"))?;
            items.extend(
                response["value"]
                    .as_array()
                    .ok_or(Failure(502, "Missing directory entries"))?
                    .clone(),
            );
            match response["@odata.nextLink"].as_str() {
                Some(url) => {
                    next = url
                        .strip_prefix(&format!("{GRAPH}/"))
                        .map(|p| format!("/{p}"))
                        .ok_or(Failure(502, "Untrusted page address"))?
                }
                None => break,
            }
        }
        items.retain(|item| !auxiliary(item["name"].as_str().unwrap_or("")));
        Ok(items)
    }
    fn download(&mut self, value: &str) -> DavResult<File> {
        if auxiliary(value) {
            return File::open(self.local_path(value)?)
                .map_err(|_| Failure(404, "Local metadata missing"));
        }
        let mut response = checked_dav(
            self.send(Method::GET, &format!("{}:/content", path(value)))?
                .timeout(Duration::from_secs(3600))
                .send()
                .map_err(|e| anyhow!(e.without_url()))?,
        )?;
        let mut file = tempfile::tempfile()?;
        std::io::copy(&mut response, &mut file)?;
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
    fn upload(&mut self, value: &str, mut file: File, version: Option<&str>) -> DavResult<Value> {
        if auxiliary(value) {
            return self.local_upload(value, file, version);
        }
        let len = file.metadata()?.len();
        let exists = match self.metadata_request(value) {
            Ok(item) => Some(item),
            Err(Failure(404, _)) => None,
            Err(error) => return Err(error),
        };
        if let Some(item) = &exists {
            if item["folder"].is_object() {
                return Err(Failure(405, "Cannot replace directory"));
            }
            if version != item["eTag"].as_str() {
                return Err(Failure(412, "Cloud file changed; refresh before replacing"));
            }
        }
        let content_path = format!(
            "{}:/content?@microsoft.graph.conflictBehavior={}",
            path(value),
            if exists.is_some() { "replace" } else { "fail" }
        );
        if len <= 250 * 1024 * 1024 {
            let mut req = self
                .send(Method::PUT, &content_path)?
                .header("Content-Type", "application/octet-stream")
                .header("Content-Length", len)
                .timeout(Duration::from_secs(3600));
            if let Some(version) = version {
                req = req.header("If-Match", version);
            }
            return checked_dav(
                req.body(file)
                    .send()
                    .map_err(|e| anyhow!(e.without_url()))?,
            )?
            .json()
            .map_err(|_| Failure(502, "Invalid upload response"));
        }
        let mut req=self.send(Method::POST,&format!("{}:/createUploadSession",path(value)))?.json(&json!({"item":{"@microsoft.graph.conflictBehavior":if exists.is_some(){"replace"}else{"fail"}}}));
        if let Some(version) = version {
            req = req.header("If-Match", version);
        }
        let session: Value = checked_dav(req.send().map_err(|e| anyhow!(e.without_url()))?)?
            .json()
            .map_err(|_| Failure(502, "Invalid upload session"))?;
        let upload = session["uploadUrl"]
            .as_str()
            .ok_or(Failure(502, "Missing upload endpoint"))?;
        let url = url::Url::parse(upload).map_err(|_| Failure(502, "Invalid upload endpoint"))?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err(Failure(502, "Unsafe upload endpoint"));
        }
        let mut offset = 0;
        while offset < len {
            let n = (len - offset).min(10 * 327680) as usize;
            let mut chunk = vec![0; n];
            file.read_exact(&mut chunk)?;
            // Upload-session URLs are preauthenticated. Never add the Graph bearer token.
            let response = checked_dav(
                self.cloud
                    .client
                    .put(url.clone())
                    .header(
                        "Content-Range",
                        format!("bytes {}-{}/{len}", offset, offset + n as u64 - 1),
                    )
                    .timeout(Duration::from_secs(300))
                    .body(chunk)
                    .send()
                    .map_err(|e| anyhow!(e.without_url()))?,
            )?;
            offset += n as u64;
            if offset == len {
                return response
                    .json()
                    .map_err(|_| Failure(502, "Invalid completed upload"));
            }
        }
        Err(Failure(502, "Upload incomplete"))
    }
    fn mkdir(&mut self, value: &str) -> DavResult<Value> {
        if auxiliary(value) {
            let path = self.local_path(value)?;
            std::fs::create_dir_all(path.parent().ok_or(Failure(403, "Invalid metadata path"))?)?;
            std::fs::create_dir(path)?;
            return self.local_metadata(value);
        }
        let (parent, name) = value.rsplit_once('/').unwrap_or(("", value));
        let parent = self.metadata_request(parent)?;
        checked_dav(
            self.send(
                Method::POST,
                &format!(
                    "/me/drive/items/{}/children",
                    segment(
                        parent["id"]
                            .as_str()
                            .ok_or(Failure(502, "Missing parent"))?
                    )
                ),
            )?
            .json(&json!({"name":name,"folder":{},"@microsoft.graph.conflictBehavior":"fail"}))
            .send()
            .map_err(|e| anyhow!(e.without_url()))?,
        )?
        .json()
        .map_err(|_| Failure(502, "Invalid directory response"))
    }
    fn delete(&mut self, value: &str, version: &str) -> DavResult<()> {
        if auxiliary(value) {
            let item = self.local_metadata(value)?;
            if item["eTag"].as_str() != Some(version) {
                return Err(Failure(412, "Metadata changed"));
            }
            let path = self.local_path(value)?;
            if path.is_dir() {
                std::fs::remove_dir_all(path)?;
            } else {
                std::fs::remove_file(path)?;
            }
            return Ok(());
        }
        checked_dav(
            self.send(Method::DELETE, &path(value))?
                .header("If-Match", version)
                .send()
                .map_err(|e| anyhow!(e.without_url()))?,
        )?;
        Ok(())
    }
    fn move_item(&mut self, value: &str, target: &str, version: &str) -> DavResult<Value> {
        if auxiliary(value) || auxiliary(target) {
            if !auxiliary(value) || !auxiliary(target) {
                return Err(Failure(403, "Reserved Finder metadata name"));
            }
            if self.local_metadata(value)?["eTag"].as_str() != Some(version) {
                return Err(Failure(412, "Metadata changed"));
            }
            let destination = self.local_path(target)?;
            std::fs::create_dir_all(
                destination
                    .parent()
                    .ok_or(Failure(403, "Invalid destination"))?,
            )?;
            std::fs::rename(self.local_path(value)?, destination)?;
            return self.local_metadata(target);
        }
        let (parent, name) = target.rsplit_once('/').unwrap_or(("", target));
        let parent = self.metadata_request(parent)?;
        checked_dav(self.send(Method::PATCH,&path(value))?.header("If-Match",version).json(&json!({"name":name,"parentReference":{"id":parent["id"]},"@microsoft.graph.conflictBehavior":"fail"})).send().map_err(|e|anyhow!(e.without_url()))?)?.json().map_err(|_|Failure(502,"Invalid move response"))
    }
}

// Finder writes AppleDouble and view preferences while browsing. Keep these
// local so merely opening the cloud disk doesn't upload macOS bookkeeping.
fn auxiliary(path: &str) -> bool {
    path.split('/').any(|name| {
        name.starts_with("._")
            || matches!(
                name,
                ".DS_Store" | ".TemporaryItems" | ".Trashes" | ".fseventsd" | ".Spotlight-V100"
            )
    })
}
impl GraphDrive {
    fn local_path(&self, path: &str) -> DavResult<PathBuf> {
        if path.starts_with('/')
            || path
                .split('/')
                .any(|part| part == "." || part == ".." || part.contains(['\\', '\0']))
        {
            return Err(Failure(403, "Invalid metadata path"));
        }
        Ok(self.metadata_directory.join(path))
    }
    fn local_metadata(&self, path: &str) -> DavResult<Value> {
        let file = self.local_path(path)?;
        let metadata =
            std::fs::metadata(file).map_err(|_| Failure(404, "Local metadata missing"))?;
        let modified = metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Failure(502, "Invalid timestamp"))?;
        let date =
            chrono::DateTime::from_timestamp(modified.as_secs() as i64, modified.subsec_nanos())
                .ok_or(Failure(502, "Invalid timestamp"))?
                .to_rfc3339();
        Ok(
            json!({"id":path,"name":path.rsplit('/').next().unwrap_or(path),"size":metadata.len(),"lastModifiedDateTime":date,"eTag":format!("\"local-{}-{}\"",modified.as_nanos(),metadata.len()),"folder":if metadata.is_dir(){json!({})}else{Value::Null}}),
        )
    }
    fn local_upload(&self, path: &str, mut file: File, version: Option<&str>) -> DavResult<Value> {
        let existed = match self.local_metadata(path) {
            Ok(item) => {
                if item["eTag"].as_str() != version {
                    return Err(Failure(412, "Metadata changed"));
                }
                true
            }
            Err(Failure(404, _)) => false,
            Err(error) => return Err(error),
        };
        let destination = self.local_path(path)?;
        let parent = destination
            .parent()
            .ok_or(Failure(403, "Invalid metadata path"))?;
        std::fs::create_dir_all(parent)?;
        let mut staging = tempfile::NamedTempFile::new_in(parent)?;
        std::io::copy(&mut file, &mut staging)?;
        if existed {
            staging
                .persist(destination)
                .map_err(|_| Failure(507, "Cannot save local metadata"))?;
        } else {
            staging
                .persist_noclobber(destination)
                .map_err(|_| Failure(412, "Metadata already exists"))?;
        }
        self.local_metadata(path)
    }
}
