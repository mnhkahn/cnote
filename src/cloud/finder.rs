//! A loopback-only WebDAV bridge. Finder provides the filesystem and lazy reads;
//! OAuth credentials never leave this process or enter the mounted server URL.
use super::*;
use anyhow::anyhow;
use base64::Engine;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tiny_http::{Header, Request, Response as DavResponse, Server, StatusCode as DavStatus};

mod graph;
#[cfg(test)]
mod tests;

#[derive(Debug)]
struct Failure(u16, &'static str);
type DavResult<T> = std::result::Result<T, Failure>;
impl From<anyhow::Error> for Failure {
    fn from(_: anyhow::Error) -> Self {
        Self(503, "OneDrive temporarily unavailable")
    }
}
impl From<std::io::Error> for Failure {
    fn from(_: std::io::Error) -> Self {
        Self(507, "Local transfer failed")
    }
}
trait Drive: Send {
    fn metadata(&mut self, path: &str) -> DavResult<Value>;
    fn children(&mut self, path: &str) -> DavResult<Vec<Value>>;
    fn download(&mut self, path: &str) -> DavResult<File>;
    fn upload(&mut self, path: &str, file: File, version: Option<&str>) -> DavResult<Value>;
    fn mkdir(&mut self, path: &str) -> DavResult<Value>;
    fn delete(&mut self, path: &str, version: &str) -> DavResult<()>;
    fn move_item(&mut self, path: &str, target: &str, version: &str) -> DavResult<Value>;
    fn authorized(&mut self) -> bool;
}
struct Lock {
    token: String,
    expires: Instant,
    version: Option<String>,
}
struct Bridge {
    drive: Mutex<Box<dyn Drive>>,
    versions: Mutex<HashMap<String, String>>,
    locks: Mutex<HashMap<String, Lock>>,
    password: String,
    authority: String,
    valid: AtomicBool,
    stop: AtomicBool,
}
struct Mounted {
    bridge: Arc<Bridge>,
    path: PathBuf,
    account: String,
}
static MOUNT: OnceLock<Mutex<Option<Mounted>>> = OnceLock::new();
fn mount_state() -> &'static Mutex<Option<Mounted>> {
    MOUNT.get_or_init(|| Mutex::new(None))
}

fn header(request: &Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_owned())
}
fn h(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("static DAV header")
}
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn href(path: &str, folder: bool) -> String {
    let value = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(segment)
        .collect::<Vec<_>>()
        .join("/");
    format!(
        "/CNote/{}{}",
        value,
        if folder && !value.is_empty() { "/" } else { "" }
    )
}
fn path_from_url(raw: &str, authority: &str) -> DavResult<String> {
    let path = if raw.starts_with("http://") || raw.starts_with("https://") {
        let url = url::Url::parse(raw).map_err(|_| Failure(400, "Invalid destination"))?;
        if url.scheme() != "http"
            || url.authority() != authority
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
        {
            return Err(Failure(403, "Destination outside CNote"));
        }
        url.path().to_owned()
    } else {
        raw.to_owned()
    };
    if path.contains(['?', '#']) {
        return Err(Failure(400, "Invalid path"));
    }
    let path = path
        .strip_prefix("/CNote")
        .filter(|p| p.is_empty() || p.starts_with('/'))
        .ok_or(Failure(404, "Not found"))?;
    let mut parts = Vec::new();
    for part in path.split('/').filter(|s| !s.is_empty()) {
        let part = percent_encoding::percent_decode_str(part)
            .decode_utf8()
            .map_err(|_| Failure(400, "Invalid UTF-8 path"))?;
        if part == "."
            || part == ".."
            || part.contains(['/', '\\', '\0'])
            || part.chars().any(char::is_control)
        {
            return Err(Failure(403, "Invalid path component"));
        }
        parts.push(part.into_owned());
    }
    Ok(parts.join("/"))
}
fn properties(path: &str, item: &Value) -> String {
    let folder = item["folder"].is_object();
    let modified = item["lastModifiedDateTime"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| {
            d.with_timezone(&chrono::Utc)
                .format("%a, %d %b %Y %H:%M:%S GMT")
                .to_string()
        })
        .unwrap_or_else(|| "Thu, 01 Jan 1970 00:00:00 GMT".into());
    format!(
        "<D:response><D:href>{}</D:href><D:propstat><D:prop><D:displayname>{}</D:displayname><D:resourcetype>{}</D:resourcetype><D:getcontentlength>{}</D:getcontentlength><D:getlastmodified>{}</D:getlastmodified><D:getetag>{}</D:getetag><D:getcontenttype>{}</D:getcontenttype><D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock><D:lockdiscovery/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
        xml(&href(path, folder)),
        xml(item["name"].as_str().unwrap_or("CNote")),
        if folder { "<D:collection/>" } else { "" },
        item["size"].as_u64().unwrap_or(0),
        modified,
        xml(item["eTag"].as_str().unwrap_or("")),
        if folder {
            "httpd/unix-directory"
        } else {
            "application/octet-stream"
        }
    )
}
impl Bridge {
    fn remember(&self, path: &str, item: &Value) {
        if let Some(etag) = item["eTag"].as_str() {
            self.versions
                .lock()
                .unwrap()
                .insert(path.into(), etag.into());
        }
    }
    fn version(&self, path: &str, request: &Request) -> DavResult<Option<String>> {
        if let Some(value) = header(request, "If-Match") {
            if value != "*" {
                return Ok(Some(value));
            }
        }
        if let Some(lock) = self.locks.lock().unwrap().get(path) {
            if header(request, "If").is_some_and(|value| value.contains(&lock.token)) {
                return Ok(lock.version.clone());
            }
        }
        Ok(self.versions.lock().unwrap().get(path).cloned())
    }
    fn check_lock(&self, path: &str, request: &Request) -> DavResult<()> {
        let mut locks = self.locks.lock().unwrap();
        locks.retain(|_, l| l.expires > Instant::now());
        for (locked, lock) in locks.iter() {
            if (path == locked || path.starts_with(&format!("{locked}/")))
                && !header(request, "If").is_some_and(|v| v.contains(&lock.token))
            {
                return Err(Failure(423, "Resource locked"));
            }
        }
        Ok(())
    }
    fn serve(&self, mut request: Request) {
        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("cnote:{}", self.password))
        );
        // Browsers must never be able to use their origin to make cloud changes.
        if header(&request, "Authorization").as_deref() != Some(&expected)
            || header(&request, "Origin").is_some()
        {
            let _ = request.respond(
                DavResponse::empty(401).with_header(h("WWW-Authenticate", "Basic realm=\"CNote\"")),
            );
            return;
        }
        if !self.valid.load(Ordering::SeqCst) {
            let _ = request.respond(DavResponse::empty(503));
            return;
        }
        let result = self.route(&mut request);
        match result {
            Ok(response) => {
                let _ = request.respond(response);
            }
            Err(Failure(code, message)) => {
                let _ = request.respond(DavResponse::from_string(message).with_status_code(code));
            }
        }
    }
    fn route(&self, request: &mut Request) -> DavResult<DavResponse<Box<dyn Read + Send>>> {
        let method = request.method().as_str().to_owned();
        #[cfg(test)]
        if std::env::var_os("CNOTE_DAV_TRACE").is_some() {
            eprintln!("DAV {} {}", method, request.url());
        }
        let path = path_from_url(request.url(), &self.authority)?;
        let mut drive = self.drive.lock().unwrap();
        if !drive.authorized() {
            return Err(Failure(503, "Please sign in to OneDrive in CNote"));
        }
        let empty = |code| DavResponse::empty(code).boxed();
        match method.as_str() {
            "OPTIONS"=>Ok(empty(200).with_header(h("DAV","1, 2")).with_header(h("MS-Author-Via","DAV")).with_header(h("Allow","OPTIONS, PROPFIND, HEAD, GET, PUT, MKCOL, MOVE, COPY, DELETE, LOCK, UNLOCK, PROPPATCH"))),
            "PROPFIND"=>{
                let item=drive.metadata(&path)?;self.remember(&path,&item);
                let depth=header(request,"Depth").unwrap_or_else(||"1".into());
                if depth!="0"&&depth!="1"{return Err(Failure(403,"Only Depth 0 and 1 are supported"));}
                let mut body=String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?><D:multistatus xmlns:D=\"DAV:\">");body.push_str(&properties(&path,&item));
                if depth!="0"&&item["folder"].is_object(){for child in drive.children(&path)? {let child_path=if path.is_empty(){field_name(&child)?}else{format!("{path}/{}",field_name(&child)?)};self.remember(&child_path,&child);body.push_str(&properties(&child_path,&child));}}
                body.push_str("</D:multistatus>");Ok(DavResponse::from_string(body).with_status_code(207).with_header(h("Content-Type","application/xml; charset=utf-8")).boxed())
            }
            "HEAD"|"GET"=>{
                let item=drive.metadata(&path)?;self.remember(&path,&item);
                if item["folder"].is_object(){return Err(Failure(405,"Use PROPFIND for directories"));}
                let length=item["size"].as_u64().unwrap_or(0);
                if method=="HEAD" {return Ok(empty(200).with_header(h("Content-Length",&length.to_string())).with_header(h("ETag",item["eTag"].as_str().unwrap_or(""))));}
                let mut file=drive.download(&path)?;let length=file.metadata()?.len();
                let range=header(request,"Range");let (start,end,partial)=byte_range(range.as_deref(),length)?;
                file.seek(SeekFrom::Start(start))?;let size=if length==0{0}else{end-start+1};
                let mut result=DavResponse::new(DavStatus(if partial{206}else{200}),vec![h("Content-Type","application/octet-stream"),h("Accept-Ranges","bytes"),h("ETag",item["eTag"].as_str().unwrap_or(""))],Box::new(file.take(size)) as Box<dyn Read+Send>,Some(size.try_into().map_err(|_|Failure(507,"File too large"))?),None);
                if partial {result.add_header(h("Content-Range",&format!("bytes {start}-{end}/{length}")));}Ok(result)
            }
            "PUT"=>{
                if path.is_empty(){return Err(Failure(403,"Cannot replace root"));}self.check_lock(&path,request)?;
                let mut file=tempfile::tempfile()?;std::io::copy(request.as_reader(),&mut file)?;file.seek(SeekFrom::Start(0))?;
                let version=self.version(&path,request)?;let existed=version.is_some();
                let item=drive.upload(&path,file,version.as_deref())?;self.remember(&path,&item);
                if let Some(lock)=self.locks.lock().unwrap().get_mut(&path){lock.version=item["eTag"].as_str().map(str::to_owned); }
                Ok(empty(if existed{204}else{201}).with_header(h("ETag",item["eTag"].as_str().unwrap_or(""))))
            }
            "MKCOL"=>{if path.is_empty(){return Err(Failure(405,"Root exists"));}self.check_lock(&path,request)?;let item=drive.mkdir(&path)?;self.remember(&path,&item);Ok(empty(201))}
            "DELETE"=>{if path.is_empty(){return Err(Failure(403,"Cannot delete root"));}self.check_lock(&path,request)?;let version=self.version(&path,request)?.ok_or(Failure(412,"Refresh before deleting"))?;drive.delete(&path,&version)?;self.versions.lock().unwrap().retain(|p,_|p!=&path&&!p.starts_with(&format!("{path}/")));Ok(empty(204))}
            "MOVE"|"COPY"=>{
                let target=path_from_url(&header(request,"Destination").ok_or(Failure(400,"Missing destination"))?,&self.authority)?;
                if path.is_empty()||target.is_empty()||target==path||target.starts_with(&format!("{path}/")){return Err(Failure(403,"Invalid destination"));}
                self.check_lock(&path,request)?;self.check_lock(&target,request)?;
                if method=="MOVE" {let version=self.version(&path,request)?.ok_or(Failure(412,"Refresh before moving"))?;if drive.metadata(&path)?["eTag"].as_str()!=Some(&version){return Err(Failure(412,"Source changed"));}}
                match drive.metadata(&target){Ok(_)=>{if header(request,"Overwrite").as_deref()==Some("F"){return Err(Failure(412,"Destination exists"));}let version=self.versions.lock().unwrap().get(&target).cloned().ok_or(Failure(412,"Refresh destination before replacing"))?;drive.delete(&target,&version)?;},Err(Failure(404,_))=>{},Err(e)=>return Err(e)}
                if method=="MOVE" {let version=self.version(&path,request)?.ok_or(Failure(412,"Refresh before moving"))?;let item=drive.move_item(&path,&target,&version)?;self.remember(&target,&item);self.versions.lock().unwrap().remove(&path);}else{copy_tree(&mut **drive,&path,&target,0)?;}
                Ok(empty(201))
            }
            "LOCK"=>{
                let mut locks=self.locks.lock().unwrap();locks.retain(|_,l|l.expires>Instant::now());
                let supplied=header(request,"If").unwrap_or_default();
                let token=if let Some(lock)=locks.get_mut(&path){if !supplied.contains(&lock.token){return Err(Failure(423,"Already locked"));}lock.expires=Instant::now()+Duration::from_secs(600);lock.token.clone()}else{let token=format!("urn:uuid:{}",uuid::Uuid::new_v4());locks.insert(path.clone(),Lock{token:token.clone(),expires:Instant::now()+Duration::from_secs(600),version:self.versions.lock().unwrap().get(&path).cloned()});token};
                let body=format!("<?xml version=\"1.0\"?><D:prop xmlns:D=\"DAV:\"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-600</D:timeout><D:locktoken><D:href>{token}</D:href></D:locktoken><D:lockroot><D:href>{}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>",xml(&href(&path,false)));
                Ok(DavResponse::from_string(body).with_header(h("Content-Type","application/xml")).with_header(h("Lock-Token",&format!("<{token}>"))).boxed())
            }
            "UNLOCK"=>{let mut locks=self.locks.lock().unwrap();if !locks.get(&path).is_some_and(|lock|header(request,"Lock-Token").is_some_and(|s|s==format!("<{}>",lock.token))){return Err(Failure(409,"Invalid lock token"));}locks.remove(&path);Ok(empty(204))}
            "PROPPATCH"=>Err(Failure(403,"Cloud file attributes are read-only")),
            _=>Err(Failure(405,"Method not supported")),
        }
    }
}
fn byte_range(range: Option<&str>, length: u64) -> DavResult<(u64, u64, bool)> {
    let Some(range) = range else {
        return Ok((0, length.saturating_sub(1), false));
    };
    let range = range
        .strip_prefix("bytes=")
        .ok_or(Failure(416, "Invalid range"))?;
    let (start, end) = range.split_once('-').ok_or(Failure(416, "Invalid range"))?;
    if length == 0 {
        return Err(Failure(416, "Empty file"));
    }
    if start.is_empty() {
        let count: u64 = end.parse().map_err(|_| Failure(416, "Invalid suffix"))?;
        if count == 0 {
            return Err(Failure(416, "Empty suffix"));
        }
        return Ok((length.saturating_sub(count), length - 1, true));
    }
    let start: u64 = start.parse().map_err(|_| Failure(416, "Invalid range"))?;
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>()
            .map_err(|_| Failure(416, "Invalid range"))?
            .min(length - 1)
    };
    if start >= length || end < start {
        return Err(Failure(416, "Invalid range"));
    }
    Ok((start, end, true))
}
fn field_name(item: &Value) -> DavResult<String> {
    let name = item["name"].as_str().ok_or(Failure(502, "Missing name"))?;
    if name.contains('/') || name == "." || name == ".." {
        return Err(Failure(502, "Invalid cloud name"));
    }
    Ok(name.to_owned())
}
fn copy_tree(drive: &mut dyn Drive, source: &str, target: &str, depth: usize) -> DavResult<()> {
    if depth > 100 {
        return Err(Failure(507, "Directory too deep"));
    }
    let item = drive.metadata(source)?;
    if item["folder"].is_object() {
        drive.mkdir(target)?;
        for child in drive.children(source)? {
            let name = field_name(&child)?;
            copy_tree(
                drive,
                &format!("{source}/{name}"),
                &format!("{target}/{name}"),
                depth + 1,
            )?;
        }
    } else {
        let file = drive.download(source)?;
        drive.upload(target, file, None)?;
    }
    Ok(())
}
fn launch(drive: Box<dyn Drive>) -> Result<(Arc<Bridge>, u16)> {
    let server = Server::http("127.0.0.1:0").map_err(|_| anyhow!("无法启动 Finder 文件服务"))?;
    let port = server
        .server_addr()
        .to_ip()
        .context("文件服务地址无效")?
        .port();
    let bridge = Arc::new(Bridge {
        drive: Mutex::new(drive),
        versions: Mutex::new(HashMap::new()),
        locks: Mutex::new(HashMap::new()),
        password: uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string(),
        authority: format!("127.0.0.1:{port}"),
        valid: AtomicBool::new(true),
        stop: AtomicBool::new(false),
    });
    let shared = bridge.clone();
    std::thread::Builder::new()
        .name("cnote-finder-dav".into())
        .spawn(move || {
            // Fixed worker pool bounds both local resource consumption and cloud concurrency.
            let server = Arc::new(server);
            let mut workers = Vec::new();
            for index in 0..4 {
                let server = server.clone();
                let bridge = shared.clone();
                workers.push(
                    std::thread::Builder::new()
                        .name(format!("cnote-finder-{index}"))
                        .spawn(move || {
                            while !bridge.stop.load(Ordering::SeqCst) {
                                match server.recv_timeout(Duration::from_millis(200)) {
                                    Ok(Some(request)) => bridge.serve(request),
                                    Ok(None) => {}
                                    Err(_) => break,
                                }
                            }
                        }),
                );
            }
            for worker in workers.into_iter().flatten() {
                let _ = worker.join();
            }
        })?;
    Ok((bridge, port))
}
pub fn connect() -> Result<PathBuf> {
    let mut state = mount_state()
        .lock()
        .map_err(|_| anyhow!("Finder 连接状态不可用"))?;
    if let Some(mount) = state.as_ref() {
        if is_mounted(&mount.path) && mount.bridge.valid.load(Ordering::SeqCst) {
            sidebar(&mount.path, true)?;
            return Ok(mount.path.clone());
        }
        if is_mounted(&mount.path) {
            unmount_volume(&mount.path)?;
        }
        mount.bridge.stop.store(true, Ordering::SeqCst);
        *state = None;
    }
    let tokens = crate::credential_store::get("onedrive-oauth")?.context("请先登录 OneDrive")?;
    let client = Client::builder()
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("CNote/", env!("CNOTE_APP_VERSION")))
        .build()?;
    let mut cloud = Cloud {
        client,
        tokens: Some(serde_json::from_str(&tokens)?),
    };
    let Reply::Account { id: account, .. } = cloud.account()? else {
        bail!("无法确认 OneDrive 账号")
    };
    // NetAuth rejects mounts inside TCC-protected Application Support folders.
    // Use a private, app-owned directory under the user's home instead.
    let parent = directories::UserDirs::new()
        .context("无法找到用户目录")?
        .home_dir()
        .join(".cnote-finder");
    std::fs::create_dir_all(&parent)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))?;
    let directory = parent.join("CNote");
    std::fs::create_dir_all(&directory)?;
    anyhow::ensure!(
        !is_mounted(&directory),
        "已有 CNote 云盘连接，请先在 Finder 中推出 CNote 或关闭另一个 CNote 实例"
    );
    let (bridge, port) = launch(Box::new(graph::GraphDrive {
        cloud,
        account: account.clone(),
        metadata_directory: directory
            .parent()
            .context("Finder 目录无效")?
            .join("metadata")
            .join(segment(&account)),
    }))?;
    let result = mount_volume(port, &directory, &bridge.password);
    if let Err(error) = result {
        bridge.stop.store(true, Ordering::SeqCst);
        return Err(error);
    }
    *state = Some(Mounted {
        bridge,
        path: directory.clone(),
        account,
    });
    sidebar(&directory, true)?;
    Ok(directory)
}
fn mount_volume(port: u16, path: &Path, password: &str) -> Result<()> {
    unsafe extern "C" {
        fn cnote_finder_mount(
            address: *const std::ffi::c_char,
            directory: *const std::ffi::c_char,
            password: *const std::ffi::c_char,
        ) -> i32;
    }
    let address = std::ffi::CString::new(format!("http://127.0.0.1:{port}/CNote/"))?;
    let directory = std::ffi::CString::new(path.to_str().context("挂载路径无效")?)?;
    let password = std::ffi::CString::new(password)?;
    let code =
        unsafe { cnote_finder_mount(address.as_ptr(), directory.as_ptr(), password.as_ptr()) };
    anyhow::ensure!(code == 0, "Finder 云盘挂载失败（系统错误 {code}）");
    Ok(())
}
fn sidebar(path: &Path, add: bool) -> Result<()> {
    unsafe extern "C" {
        fn cnote_finder_sidebar(directory: *const std::ffi::c_char, add: i32) -> i32;
    }
    let path = std::ffi::CString::new(path.to_str().context("云盘目录无效")?)?;
    anyhow::ensure!(
        unsafe { cnote_finder_sidebar(path.as_ptr(), i32::from(add)) } != 0,
        "云盘已连接，但无法固定 Finder 侧栏入口"
    );
    Ok(())
}
fn is_mounted(path: &Path) -> bool {
    unsafe extern "C" {
        fn cnote_finder_is_mounted(directory: *const std::ffi::c_char) -> i32;
    }
    let Some(path) = path.to_str().and_then(|s| std::ffi::CString::new(s).ok()) else {
        return false;
    };
    unsafe { cnote_finder_is_mounted(path.as_ptr()) != 0 }
}
fn unmount_volume(path: &Path) -> Result<()> {
    let status = std::process::Command::new("/sbin/umount")
        .arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    anyhow::ensure!(
        status.success(),
        "Finder 云盘仍有文件在使用，请关闭相关文件或在 Finder 中推出 CNote 后重试"
    );
    Ok(())
}
pub fn disconnect() -> Result<()> {
    let mut state = mount_state()
        .lock()
        .map_err(|_| anyhow!("Finder 连接状态不可用"))?;
    if let Some(mount) = state.as_ref() {
        if is_mounted(&mount.path) {
            let status = std::process::Command::new("/sbin/umount")
                .arg(&mount.path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()?;
            anyhow::ensure!(
                status.success(),
                "Finder 云盘仍有文件在使用，请关闭相关文件或在 Finder 中推出 CNote 后重试"
            );
        }
        let _ = sidebar(&mount.path, false);
        mount.bridge.valid.store(false, Ordering::SeqCst);
        mount.bridge.stop.store(true, Ordering::SeqCst);
    }
    *state = None;
    Ok(())
}
pub fn account_changed(account: &str) {
    let invalid = if let Ok(state) = mount_state().lock() {
        if let Some(mount) = state.as_ref() {
            if mount.account != account {
                mount.bridge.valid.store(false, Ordering::SeqCst);
                true
            } else {
                false
            }
        } else {
            false
        }
    } else {
        false
    };
    if invalid {
        let _ = disconnect();
    }
}
