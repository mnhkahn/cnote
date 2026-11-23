//! Native Trello API client. User credentials live only in Keychain.
#[path = "trello_download.rs"]
pub mod download;
#[cfg(not(cnote_shared_core))]
#[path = "trello_notifications.rs"]
pub mod notifications;
#[path = "trello_review.rs"]
mod review;
use anyhow::{Context, Result, bail};
use base64::Engine;
use reqwest::{StatusCode, blocking::Client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Read,
    sync::Mutex,
    time::{Duration, Instant},
};

static AUTH: Mutex<Session> = Mutex::new(Session {
    loaded: false,
    auth: None,
    account: String::new(),
    account_name: String::new(),
    pending_connection: false,
    remote_revision: String::new(),
});
#[derive(Default)]
struct Session {
    loaded: bool,
    auth: Option<Credentials>,
    account: String,
    account_name: String,
    pending_connection: bool,
    remote_revision: String,
}
impl Session {
    fn restore_with(
        &mut self,
        read: impl FnOnce() -> Result<Option<Credentials>>,
    ) -> Result<Option<Credentials>> {
        if !self.loaded {
            self.auth = read()?;
            self.loaded = true;
        }
        Ok(self.auth.clone())
    }
    fn auth(&mut self) -> Result<Option<Credentials>> {
        let account = self.account.clone();
        if !self.loaded
            && let Some(record) = links()?.get(&account)
        {
            self.pending_connection = record.pending;
            self.remote_revision = record.cloud_revision.clone().unwrap_or_default();
        }
        self.restore_with(|| stored_for(&account))
    }
}

/// The engine supplies the verified Microsoft identity, never an IPC argument.
pub fn account_changed(account: &str, name: &str) {
    if let Ok(mut session) = AUTH.lock() {
        if session.account != account {
            session.account = account.into();
            session.loaded = false;
            session.auth = None;
            session.pending_connection = false;
            session.remote_revision.clear();
        }
        session.account_name = name.into();
    }
}
#[derive(Debug)]
struct AuthRequired;
impl std::fmt::Display for AuthRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Trello 授权已失效，请重新关联")
    }
}
impl std::error::Error for AuthRequired {}
pub fn error_code(error: &anyhow::Error) -> &'static str {
    if error.is::<AuthRequired>() {
        "auth_required"
    } else {
        "request_failed"
    }
}
const API: &str = "https://api.trello.com/1";
const BOARD_CARD_FIELDS: &str =
    "name,desc,start,due,dueComplete,idList,closed,url,labels,dateLastActivity,dateCompleted";
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Credentials {
    key: String,
    token: String,
}
// Shared by desktop and Android hosts; survives feature WebView recreation.
// Kept in memory only, with credentials included in the identity to prevent
// reuse after reauthorization or switching accounts.
const LIST_CACHE_TTL: Duration = Duration::from_secs(300);
static LIST_CACHE: Mutex<ListCache> = Mutex::new(ListCache {
    entries: Vec::new(),
});
struct ListCache {
    entries: Vec<(String, Credentials, String, Instant, Value)>,
}
impl ListCache {
    fn read(&self, account: &str, auth: &Credentials, key: &str, now: Instant) -> Option<Value> {
        self.entries
            .iter()
            .find(|(owner, credentials, id, at, _)| {
                owner == account
                    && credentials == auth
                    && id == key
                    && now.saturating_duration_since(*at) < LIST_CACHE_TTL
            })
            .map(|entry| entry.4.clone())
    }
    fn store(&mut self, account: &str, auth: &Credentials, key: &str, value: &Value) {
        self.entries.retain(|(owner, credentials, id, at, _)| {
            owner == account && credentials == auth && id != key && at.elapsed() < LIST_CACHE_TTL
        });
        if self.entries.len() >= 8 {
            self.entries.remove(0);
        }
        self.entries.push((
            account.into(),
            auth.clone(),
            key.into(),
            Instant::now(),
            value.clone(),
        ));
    }
}
fn cached_list(
    v: &Value,
    account: &str,
    auth: &Credentials,
    key: &str,
    fetch: impl FnOnce() -> Result<Value>,
) -> Result<Value> {
    // Only the feature UI opts in; other clients keep their freshness contract.
    let Some(reuse) = v["cache"].as_bool() else {
        return fetch();
    };
    let mut cache = LIST_CACHE
        .lock()
        .map_err(|_| anyhow::anyhow!("作业缓存状态异常"))?;
    if reuse && let Some(value) = cache.read(account, auth, key, Instant::now()) {
        return Ok(value);
    }
    // A failed forced refresh must not leave a formerly fresh snapshot reusable.
    cache.entries.retain(|entry| entry.2 != key);
    let value = fetch()?;
    cache.store(account, auth, key, &value);
    Ok(value)
}
struct InvalidateListCache;
impl Drop for InvalidateListCache {
    fn drop(&mut self) {
        if let Ok(mut cache) = LIST_CACHE.lock() {
            cache.entries.clear();
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct AccountLink {
    credentials: Credentials,
    member_id: String,
    member_name: String,
    board_id: String,
    board_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cloud_revision: Option<String>,
    #[serde(default)]
    pending: bool,
}
type AccountLinks = std::collections::BTreeMap<String, AccountLink>;
fn links() -> Result<AccountLinks> {
    crate::credential_store::get("trello-links")?
        .map(|value| serde_json::from_str(&value).context("作业账号关联记录损坏，未覆盖原记录"))
        .transpose()
        .map(Option::unwrap_or_default)
}
fn select_credentials(
    account: &str,
    links: &AccountLinks,
    legacy: Option<Credentials>,
) -> Option<Credentials> {
    if let Some(link) = links.get(account).filter(|_| !account.is_empty()) {
        return Some(link.credentials.clone());
    }
    // A legacy entry already assigned to another Microsoft account is not a candidate.
    legacy.filter(|credentials| !links.values().any(|link| &link.credentials == credentials))
}
fn stored_for(account: &str) -> Result<Option<Credentials>> {
    Ok(select_credentials(account, &links()?, stored()?))
}
pub fn connection_account() -> Result<String> {
    Ok(AUTH
        .lock()
        .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?
        .account
        .clone())
}
pub fn connection_sync_state(account: &str) -> Result<(bool, String)> {
    let mut session = AUTH
        .lock()
        .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?;
    anyhow::ensure!(session.account == account, "微软账号已切换，请重试");
    session.auth()?;
    Ok((session.pending_connection, session.remote_revision.clone()))
}
pub fn connection_revision(account: &str, revision: &str) -> Result<()> {
    let mut session = AUTH
        .lock()
        .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?;
    anyhow::ensure!(session.account == account, "微软账号已切换，请重试");
    session.remote_revision = revision.into();
    Ok(())
}
pub fn connection_snapshot(account: &str) -> Result<Option<(String, Value)>> {
    let session = AUTH
        .lock()
        .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?;
    anyhow::ensure!(
        session.account == account && !account.is_empty(),
        "微软账号已切换，请重试"
    );
    Ok(links()?.get(account).map(|record| (record.cloud_revision.clone().unwrap_or_default(), json!({
        "credentials":record.credentials,"member_id":record.member_id,"member_name":record.member_name,
        "board_id":record.board_id,"board_name":record.board_name
    }))))
}
pub fn restore_connection(account: &str, revision: &str, value: Value) -> Result<()> {
    anyhow::ensure!(!revision.is_empty(), "云端作业连接版本无效");
    let mut record: AccountLink = serde_json::from_value(value).context("云端作业连接格式无效")?;
    credentials(&serde_json::to_value(&record.credentials)?)?;
    identifier(&json!({"id":record.board_id}))?;
    identifier(&json!({"id":record.member_id}))?;
    record.cloud_revision = Some(revision.into());
    record.pending = false;
    let mut session = AUTH
        .lock()
        .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?;
    anyhow::ensure!(
        session.account == account && !account.is_empty(),
        "微软账号已切换，请重试"
    );
    let mut records = links()?;
    if records
        .get(account)
        .is_none_or(|existing| existing != &record)
    {
        records.insert(account.into(), record.clone());
        crate::credential_store::set("trello-links", &serde_json::to_string(&records)?)?;
    }
    session.auth = Some(record.credentials);
    session.loaded = true;
    session.pending_connection = false;
    session.remote_revision = revision.into();
    Ok(())
}
pub fn clear_missing_connection(account: &str) -> Result<()> {
    let mut session = AUTH
        .lock()
        .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?;
    anyhow::ensure!(session.account == account, "微软账号已切换，请重试");
    let mut records = links()?;
    if let Some(previous) = records
        .get(account)
        .filter(|r| r.cloud_revision.is_some())
        .cloned()
    {
        // Mark the legacy token disconnected before removing its owner mapping.
        if stored()? == Some(previous.credentials) {
            crate::credential_store::remove("trello-auth")?;
        }
        records.remove(account);
        crate::credential_store::set("trello-links", &serde_json::to_string(&records)?)?;
        session.auth = None;
        session.loaded = true;
    }
    Ok(())
}
fn stored() -> Result<Option<Credentials>> {
    crate::credential_store::get("trello-auth")?
        .map(|value| serde_json::from_str(&value).context("Trello 凭据损坏，请重新关联"))
        .transpose()
}
fn configured_key() -> &'static str {
    option_env!("CNOTE_TRELLO_API_KEY").unwrap_or("")
}
fn credentials(v: &Value) -> Result<Credentials> {
    let key = v["key"].as_str().unwrap_or_default().trim();
    let token = v["token"].as_str().unwrap_or_default().trim();
    validate_key(key)?;
    anyhow::ensure!(
        (32..=256).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric()),
        "请输入有效的 Trello Token"
    );
    Ok(Credentials {
        key: key.into(),
        token: token.into(),
    })
}
fn validate_key(key: &str) -> Result<()> {
    anyhow::ensure!(
        key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit()),
        "请输入有效的 Trello API Key"
    );
    Ok(())
}
fn authorize(key: &str) -> Result<String> {
    validate_key(key)?;
    let mut url = url::Url::parse("https://trello.com/1/authorize")?;
    url.query_pairs_mut().extend_pairs([
        ("key", key),
        ("name", "CNote"),
        ("scope", "read,write"),
        ("expiration", "never"),
        ("response_type", "token"),
    ]);
    Ok(url.into())
}
struct Api {
    client: Client,
    auth: Credentials,
}
impl Api {
    fn new(auth: Credentials) -> Result<Self> {
        let client = crate::http::client()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .context("无法初始化 Trello 连接")?;
        Ok(Self { client, auth })
    }
    fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.get_url(&format!("{API}{path}"), query)
    }
    fn get_url(&self, url: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.send_url(reqwest::Method::GET, url, query, None)
    }
    fn put(&self, path: &str, body: &Value) -> Result<Value> {
        self.send_url(
            reqwest::Method::PUT,
            &format!("{API}{path}"),
            &[],
            Some(body),
        )
    }
    fn delete(&self, path: &str) -> Result<()> {
        self.send_url(reqwest::Method::DELETE, &format!("{API}{path}"), &[], None)?;
        Ok(())
    }
    fn send_url(
        &self,
        method: reqwest::Method,
        url: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Value> {
        let writing = method != reqwest::Method::GET;
        let deleting = method == reqwest::Method::DELETE;
        // Credentials stay out of request URLs, logs and errors.
        let authorization = format!(
            "OAuth oauth_consumer_key=\"{}\", oauth_token=\"{}\"",
            self.auth.key, self.auth.token
        );
        let mut url = url::Url::parse(url).context("无效的 Trello 接口地址")?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        let mut request = self
            .client
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, authorization);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .map_err(|_| anyhow::anyhow!("无法连接 Trello，请检查网络后重试"))?;
        match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN if writing => return Err(WriteRejected("Trello 拒绝写入，请在关联设置中重新授权读写权限；若仍可查看卡片，请检查是否使用了旧的只读授权，并确认你有看板编辑权限".into()).into()),
            StatusCode::UNAUTHORIZED => return Err(AuthRequired.into()),
            StatusCode::FORBIDDEN => bail!("没有权限读取此 Trello 内容，请检查授权或选择其他看板"),
            StatusCode::TOO_MANY_REQUESTS => return Err(WriteRejected("Trello 请求过于频繁，请稍后重试".into()).into()),
            status if !status.is_success() => {
                bail!("Trello 请求失败（HTTP {}），请稍后重试", status.as_u16())
            }
            _ => {}
        }
        if deleting {
            return Ok(Value::Null);
        }
        const LIMIT: usize = 20 * 1024 * 1024;
        let mut bytes = Vec::new();
        response
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .context("读取 Trello 响应失败")?;
        anyhow::ensure!(bytes.len() <= LIMIT, "Trello 响应过大");
        serde_json::from_slice(&bytes).context("Trello 响应格式错误")
    }
}
#[derive(Debug)]
struct WriteRejected(String);
impl std::fmt::Display for WriteRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for WriteRejected {}

fn preview_mime(attachment: &Value) -> Option<&str> {
    let mime = attachment["mimeType"]
        .as_str()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    match mime {
        "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif" | "image/bmp"
        | "image/heic" | "image/heif" | "image/tiff" | "audio/mpeg" | "audio/mp4"
        | "audio/x-m4a" | "audio/wav" | "audio/x-wav" | "audio/ogg" | "audio/aac"
        | "audio/webm" | "audio/flac" | "audio/amr" | "audio/3gpp" | "audio/opus" | "video/mp4"
        | "video/webm" | "video/quicktime" | "application/pdf" | "text/plain" | "text/markdown"
        | "text/csv" | "application/json" => Some(mime),
        _ => {
            let name = attachment["name"].as_str().unwrap_or("");
            match name
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "jpg" | "jpeg" => Some("image/jpeg"),
                "png" => Some("image/png"),
                "webp" => Some("image/webp"),
                "gif" => Some("image/gif"),
                "avif" => Some("image/avif"),
                "heic" => Some("image/heic"),
                "heif" => Some("image/heif"),
                "mp3" => Some("audio/mpeg"),
                "m4a" => Some("audio/mp4"),
                "wav" => Some("audio/wav"),
                "ogg" | "opus" => Some("audio/ogg"),
                "aac" => Some("audio/aac"),
                "flac" => Some("audio/flac"),
                "amr" => Some("audio/amr"),
                "3gp" => Some("audio/3gpp"),
                "mp4" => Some("video/mp4"),
                "webm" => Some("video/webm"),
                "mov" => Some("video/quicktime"),
                "pdf" => Some("application/pdf"),
                "txt" => Some("text/plain"),
                "md" => Some("text/markdown"),
                "csv" => Some("text/csv"),
                "json" => Some("application/json"),
                _ => None,
            }
        }
    }
}
fn authorized_attachment_host(url: &url::Url) -> bool {
    url.scheme() == "https"
        && matches!(url.host_str(), Some("api.trello.com" | "trello.com"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
}
fn attachment_redirect_allowed(url: &url::Url) -> bool {
    if authorized_attachment_host(url) {
        return true;
    }
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.host_str().is_some_and(|host| {
            host.ends_with(".amazonaws.com") || host.ends_with(".cloudfront.net")
        })
}
impl Api {
    fn attachment(&self, card: &str, id: &str, original: bool) -> Result<Value> {
        let deadline = std::time::Instant::now() + Duration::from_secs(45);
        let attachment = self.get(&format!("/cards/{card}/attachments/{id}"), &[])?;
        anyhow::ensure!(
            attachment["isUpload"] == true,
            "此附件是外部链接，请在原网站查看"
        );
        let mime = preview_mime(&attachment).context("此文件暂不支持内嵌预览，请打开原附件")?;
        let mut url = url::Url::parse(&format!("{API}/cards/{card}/attachments/{id}/download/"))?;
        url.path_segments_mut()
            .unwrap()
            .pop_if_empty()
            .push(attachment["name"].as_str().unwrap_or("attachment"));
        // Thumbnails use previews; the local viewer explicitly requests original bytes.
        if !original
            && mime.starts_with("image/")
            && let Some(preview) = attachment["previews"].as_array().and_then(|items| {
                items
                    .iter()
                    .filter(|p| p["width"].as_u64().is_some_and(|w| w <= 480))
                    .max_by_key(|p| p["width"].as_u64().unwrap_or(0))
            })
            && let Some(value) = preview["url"].as_str()
        {
            let candidate = url::Url::parse(value).context("附件预览地址无效")?;
            if authorized_attachment_host(&candidate)
                && candidate
                    .path()
                    .starts_with(&format!("/1/cards/{card}/attachments/{id}/"))
            {
                url = candidate;
            }
        }
        let limit = if mime.starts_with("text/") || mime == "application/json" {
            1024 * 1024
        } else {
            25 * 1024 * 1024
        };
        for _ in 0..6 {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .context("附件下载超时，请重试")?;
            let mut request = self.client.get(url.clone()).timeout(remaining);
            if authorized_attachment_host(&url) {
                request = request.header(
                    reqwest::header::AUTHORIZATION,
                    format!(
                        "OAuth oauth_consumer_key=\"{}\", oauth_token=\"{}\"",
                        self.auth.key, self.auth.token
                    ),
                );
            }
            let response = request.send().map_err(|error| {
                if error.is_timeout() {
                    anyhow::anyhow!("附件下载超时，请重试")
                } else {
                    anyhow::anyhow!("附件加载失败，请检查网络后重试")
                }
            })?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .context("附件重定向地址缺失")?;
                let next = url
                    .join(location)
                    .map_err(|_| anyhow::anyhow!("附件重定向地址无效"))?;
                anyhow::ensure!(attachment_redirect_allowed(&next), "附件重定向地址不受支持");
                url = next;
                continue;
            }
            if response.status() == StatusCode::UNAUTHORIZED {
                return Err(AuthRequired.into());
            }
            anyhow::ensure!(
                response.status().is_success(),
                "附件加载失败（HTTP {}）",
                response.status().as_u16()
            );
            anyhow::ensure!(
                response.content_length().is_none_or(|n| n <= limit as u64),
                "附件过大，无法内嵌预览，请打开原附件"
            );
            let response_mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .to_owned();
            let mut bytes = Vec::new();
            response
                .take((limit + 1) as u64)
                .read_to_end(&mut bytes)
                .context("附件读取失败")?;
            anyhow::ensure!(
                !bytes.is_empty() && bytes.len() <= limit,
                "附件为空或过大，无法内嵌预览"
            );
            let actual = preview_mime(&json!({"mimeType":response_mime}))
                .map(str::to_owned)
                .unwrap_or_else(|| mime.to_owned());
            return Ok(
                json!({"mime":actual,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
            );
        }
        bail!("附件重定向次数过多")
    }
}

fn description_with_grade(description: &str, grade: &str) -> Result<String> {
    anyhow::ensure!(
        ["", "100", "优", "良", "中", "差"].contains(&grade),
        "请选择有效评分"
    );
    let (description, times) = homework_description_parts(description);
    let newline = if description.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let body: String = description
        .split_inclusive('\n')
        .filter(|line| {
            !line
                .split_once([':', '：'])
                .is_some_and(|(key, _)| key.trim() == "打分结果")
        })
        .collect();
    let output = if grade.is_empty() {
        body
    } else {
        format!(
            "打分结果：{grade}{}{body}",
            if body.is_empty() { "" } else { newline }
        )
    };
    Ok(with_homework_times(&output, &times))
}

fn homework_time_override(line: &str) -> Option<(&str, &str)> {
    let (field, value) = line
        .trim_end_matches(['\r', '\n'])
        .strip_prefix("<!-- cnote ")?
        .strip_suffix(" -->")?
        .split_once('=')?;
    (matches!(field, "dateCompleted" | "dateLastActivity")
        && chrono::DateTime::parse_from_rfc3339(value).is_ok())
    .then_some((field, value))
}

fn homework_description_parts(description: &str) -> (String, String) {
    let (text, mut times): (String, String) = description
        .split_inclusive('\n')
        .partition(|line| homework_time_override(line).is_none());
    if let Ok(Value::Object(mut data)) = serde_json::from_str::<Value>(&text) {
        let mut stripped = false;
        for field in ["dateCompleted", "dateLastActivity"] {
            let key = format!("_cnote_{field}");
            if let Some(value) = data.get(&key).and_then(Value::as_str)
                && chrono::DateTime::parse_from_rfc3339(value).is_ok()
            {
                times.push_str(&format!("<!-- cnote {field}={value} -->\n"));
                data.remove(&key);
                stripped = true;
            }
        }
        if stripped {
            return (Value::Object(data).to_string(), times);
        }
    }
    (text, times)
}

fn with_homework_times(description: &str, times: &str) -> String {
    if times.is_empty() {
        return description.to_owned();
    }
    if let Ok(Value::Object(mut data)) = serde_json::from_str::<Value>(description) {
        for (field, value) in times.lines().filter_map(homework_time_override) {
            data.insert(format!("_cnote_{field}"), json!(value));
        }
        return Value::Object(data).to_string();
    }
    let first = description.split_inclusive('\n').next().unwrap_or_default();
    if first
        .split_once([':', '：'])
        .is_some_and(|(key, _)| key.trim() == "打分结果")
    {
        let newline = if first.ends_with('\n') { "" } else { "\n" };
        return format!("{first}{newline}{times}{}", &description[first.len()..]);
    }
    format!("{times}{description}")
}

fn homework_type_description(description: &str, value: &str) -> Result<String> {
    anyhow::ensure!(!value.contains(['\r', '\n']), "作业类型只能填写一行");
    let (text, times) = homework_description_parts(description);
    if let Ok(Value::Object(mut data)) = serde_json::from_str::<Value>(&text) {
        if value.is_empty() {
            data.remove("type");
        } else {
            data.insert("type".into(), json!(value));
        }
        return Ok(with_homework_times(
            &serde_json::to_string_pretty(&data)?,
            &times,
        ));
    }
    let mut existing_type = false;
    let mut updated = String::new();
    for line in description.split_inclusive('\n') {
        if line.split_once([':', '：']).is_some_and(|(key, _)| {
            matches!(key.trim(), "类型" | "作业类型") || key.trim().eq_ignore_ascii_case("type")
        }) {
            if !existing_type && !value.is_empty() {
                let end = line.trim_end_matches(['\r', '\n']).len();
                updated.push_str(&format!("作业类型：{value}{}", &line[end..]));
            }
            existing_type = true;
        } else {
            updated.push_str(line);
        }
    }
    if !existing_type && !value.is_empty() {
        let newline = if description.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        updated = with_homework_times(&updated, &format!("作业类型：{value}{newline}"));
    }
    Ok(updated)
}

fn apply_homework_activity(cards: &mut [Value], actions: &[Value]) {
    let mut latest = HashMap::new();
    let mut completions = HashMap::new();
    for action in actions {
        if action["type"] != "commentCard" {
            continue;
        }
        let data = &action["data"];
        let Some(card) = data["card"]["id"].as_str() else {
            continue;
        };
        let Some((marker, payload)) = data["text"]
            .as_str()
            .and_then(|text| text.split_once('\n'))
            .and_then(|(_, text)| text.split_once('\n'))
        else {
            continue;
        };
        if marker.trim_end() != "[homework-activity:v1]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        let (Some(at), Some(correction)) = (event["at"].as_i64(), event["correction"].as_bool())
        else {
            continue;
        };
        if event["task_id"] != card || at <= 0 || chrono::DateTime::from_timestamp(at, 0).is_none()
        {
            continue;
        }
        let completed = match event["event"].as_str() {
            Some("started") => false,
            Some("completed") => true,
            _ => continue,
        };
        let current = latest.entry(card).or_insert((at, completed, correction));
        // The tablet can upload events late. A completion wins if both happened in one second.
        if (at, completed) > (current.0, current.1) {
            *current = (at, completed, correction);
        }
        if completed {
            let duration = event["duration_seconds"]
                .as_u64()
                .filter(|&seconds| seconds <= at as u64)
                .or_else(|| {
                    let start = event["started_at"].as_i64()?;
                    (1..=at).contains(&start).then(|| (at - start) as u64)
                });
            let current = completions.entry(card).or_insert((at, duration));
            if at > current.0 || (at == current.0 && current.1.is_none()) {
                *current = (at, duration);
            }
        }
    }
    for card in cards {
        let id = card["id"].as_str().unwrap_or_default();
        let activity = latest.get(id).copied();
        let completion = completions.get(id).copied();
        if let Some((at, false, correction)) = activity {
            card["homeworkStarted"] = json!({"at":at,"correction":correction});
        }
        if let Some((at, duration)) = completion {
            card["homeworkCompletedAt"] = json!(chrono::DateTime::from_timestamp(at, 0));
            card["homeworkDurationSeconds"] = json!(duration);
        }
    }
}

fn identifier(v: &Value) -> Result<&str> {
    let id = v["id"].as_str().unwrap_or_default();
    anyhow::ensure!(
        id.len() == 24 && id.bytes().all(|c| c.is_ascii_hexdigit()),
        "无效的 Trello ID"
    );
    Ok(id)
}
pub fn request(v: Value) -> Result<Value> {
    let mut session = AUTH
        .lock()
        .map_err(|_| anyhow::anyhow!("Trello 连接状态异常，请重启应用"))?;
    if let Some(account) = v.get("account_id") {
        anyhow::ensure!(
            account.as_str() == Some(session.account.as_str()),
            "微软账号已切换，请重试"
        );
    }
    let _invalidate = matches!(
        v["op"].as_str(),
        Some(
            "connect"
                | "disconnect"
                | "link_account"
                | "link_board"
                | "update_cell"
                | "delete_card"
                | "publish_homework"
                | "review_homework"
                | "manual_homework_review"
        )
    )
    .then(|| InvalidateListCache);
    match v["op"].as_str().unwrap_or_default() {
        "status" => {
            let auth = session.auth()?;
            let linked = links()?.get(&session.account).cloned();
            return Ok(
                json!({"connected":auth.is_some(),"key":auth.as_ref().map(|a| a.key.as_str()).unwrap_or(configured_key()),
                    "account_linking":true,"account_id":session.account,"linked":linked.is_some(),"board":linked.as_ref().map(|l|l.board_id.as_str())}),
            );
        }
        "link_status" | "link_account" => {
            anyhow::ensure!(!session.account.is_empty(), "请先登录微软账号");
            if v["account_id"].as_str() != Some(session.account.as_str()) {
                bail!("微软账号已切换，请重新确认关联");
            }
            let auth = session.auth()?.ok_or(AuthRequired)?;
            let account = session.account.clone();
            let account_name = session.account_name.clone();
            drop(session);
            let api = Api::new(auth.clone())?;
            let member = api.get("/members/me", &[("fields", "id,fullName,username")])?;
            if v["op"] == "link_status" {
                let boards = api.get(
                    "/members/me/boards",
                    &[("filter", "open"), ("fields", "name,closed")],
                )?;
                return Ok(
                    json!({"linked":false,"account_id":account,"account_name":account_name,"member":member,"boards":boards}),
                );
            }
            let board_id = identifier(&v)?.to_owned();
            anyhow::ensure!(
                v["member_id"] == member["id"],
                "Trello 账号已变化，请重新确认关联"
            );
            let board = api.get(&format!("/boards/{board_id}"), &[("fields", "name,closed")])?;
            anyhow::ensure!(board["closed"] == false, "请选择未归档的作业看板");
            let record = AccountLink {
                credentials: auth.clone(),
                member_id: member["id"]
                    .as_str()
                    .context("无法确认 Trello 账号")?
                    .into(),
                member_name: member["fullName"].as_str().unwrap_or_default().into(),
                board_id: board_id.clone(),
                board_name: board["name"].as_str().unwrap_or_default().into(),
                cloud_revision: None,
                pending: true,
            };
            let mut session = AUTH
                .lock()
                .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?;
            anyhow::ensure!(
                session.account == account && session.auth()? == Some(auth),
                "账号已切换，请重新确认关联"
            );
            let mut records = links()?;
            records.insert(account, record);
            crate::credential_store::set("trello-links", &serde_json::to_string(&records)?)?;
            return Ok(json!({"linked":true,"board":board_id}));
        }
        "authorize" => {
            return Ok(json!({"url":authorize(v["key"].as_str().unwrap_or_default().trim())?}));
        }
        "connect" => {
            let auth = credentials(&v)?;
            let api = Api::new(auth)?;
            let member = api.get("/members/me", &[("fields", "id,fullName,username")])?;
            crate::credential_store::set("trello-auth", &serde_json::to_string(&api.auth)?)?;
            let mut records = links()?;
            if !session.account.is_empty()
                && let Some(record) = records.get_mut(&session.account)
            {
                record.credentials = api.auth.clone();
                record.pending = true;
                crate::credential_store::set("trello-links", &serde_json::to_string(&records)?)?;
            }
            session.loaded = true;
            session.auth = Some(api.auth.clone());
            session.pending_connection = true;
            return Ok(json!({"connected":true,"name":member["fullName"]}));
        }
        "disconnect" => {
            let mut records = links()?;
            if records.remove(&session.account).is_some() {
                crate::credential_store::set("trello-links", &serde_json::to_string(&records)?)?;
            }
            crate::credential_store::remove("trello-auth")?;
            session.loaded = true;
            session.auth = None;
            session.pending_connection = false;
            session.remote_revision.clear();
            return Ok(json!({"connected":false}));
        }
        "link_board" => {
            anyhow::ensure!(
                v["account_id"].as_str() == Some(session.account.as_str())
                    && !session.account.is_empty(),
                "微软账号已切换，请重新选择看板"
            );
            let account = session.account.clone();
            let credentials = links()?
                .get(&account)
                .context("请先关联当前微软账号")?
                .credentials
                .clone();
            drop(session);
            let board_id = identifier(&v)?.to_owned();
            let board = Api::new(credentials.clone())?
                .get(&format!("/boards/{board_id}"), &[("fields", "name,closed")])?;
            anyhow::ensure!(board["closed"] == false, "请选择未归档的作业看板");
            let session = AUTH
                .lock()
                .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?;
            anyhow::ensure!(session.account == account, "微软账号已切换，请重新选择看板");
            let mut records = links()?;
            let record = records
                .get_mut(&account)
                .context("请重新关联当前微软账号")?;
            anyhow::ensure!(
                record.credentials == credentials,
                "Trello 账号已切换，请重新选择看板"
            );
            record.board_id = board_id;
            record.board_name = board["name"].as_str().unwrap_or_default().into();
            crate::credential_store::set("trello-links", &serde_json::to_string(&records)?)?;
            return Ok(json!({"saved":true}));
        }
        "boards"
        | "board"
        | "card"
        | "attachment"
        | "recognize_image"
        | "transcribe_audio"
        | "homework_attachments"
        | "update_cell"
        | "delete_card"
        | "review_homework"
        | "manual_homework_review"
        | "publish_homework"
        | "reading_source" => {}
        _ => bail!("未知的 Trello 操作"),
    }
    let api = Api::new(session.auth()?.ok_or(AuthRequired)?)?;
    let account = session.account.clone();
    drop(session);
    match v["op"].as_str().unwrap_or_default() {
        "boards" => cached_list(&v, &account, &api.auth, "boards", || {
            Ok(
                json!({"boards":api.get("/members/me/boards", &[("filter","open"),("fields","name,closed,url")])?}),
            )
        }),
        "board" => {
            let id = identifier(&v)?;
            cached_list(&v, &account, &api.auth, id, || {
                let lists = api.get(
                    &format!("/boards/{id}/lists"),
                    &[("filter", "open"), ("fields", "name,closed,pos")],
                )?;
                let mut cards = api.get(
                    &format!("/boards/{id}/cards"),
                    &[("filter", "open"), ("fields", BOARD_CARD_FIELDS)],
                )?;
                if let Some(cards) = cards.as_array_mut()
                    && !cards.is_empty()
                    && let Ok(actions) = api.get(
                        &format!("/boards/{id}/actions"),
                        &[
                            ("filter", "commentCard"),
                            ("limit", "1000"),
                            ("fields", "type,data"),
                            ("memberCreator", "false"),
                        ],
                    )
                    && let Some(actions) = actions.as_array()
                {
                    apply_homework_activity(cards, actions);
                }
                Ok(json!({"lists": lists, "cards": cards}))
            })
        }
        "update_cell" => {
            let id = identifier(&v)?;
            let _lock = review::Store::open(id)?;
            let card = api.get(
                &format!("/cards/{id}"),
                &[("fields", "desc,idBoard,idList")],
            )?;
            let description = card["desc"].as_str().unwrap_or_default();
            let field = v["field"].as_str().unwrap_or_default();
            let value = v["value"].as_str().context("缺少字段值")?;
            let body = match field {
                "progress" => {
                    let list_id = identifier(&json!({"id":v["value"]}))?.to_owned();
                    let list = api.get(
                        &format!("/lists/{list_id}"),
                        &[("fields", "name,idBoard,closed")],
                    )?;
                    anyhow::ensure!(
                        list["closed"] == false && list["idBoard"] == card["idBoard"],
                        "请选择当前看板中的有效列表"
                    );
                    let mut body = json!({"idList":list_id});
                    match list["name"].as_str().unwrap_or_default().trim() {
                        "已完成" | "已改错" => body["dueComplete"] = json!(true),
                        "待完成" | "待改错" => body["dueComplete"] = json!(false),
                        _ => {}
                    }
                    body
                }
                "grade" => {
                    json!({"desc": description_with_grade(description, value)?})
                }
                "homework_type" => {
                    json!({"desc": homework_type_description(description, value.trim())?})
                }
                "start" | "due" | "dateCompleted" | "dateLastActivity" => {
                    anyhow::ensure!(
                        (value.is_empty() && field != "due")
                            || chrono::DateTime::parse_from_rfc3339(value).is_ok(),
                        "请输入有效的日期和时间"
                    );
                    if matches!(field, "start" | "due") {
                        json!({(field): if value.is_empty() { Value::Null } else { json!(value) }})
                    } else {
                        let (text, existing_times) = homework_description_parts(description);
                        let mut times: String = existing_times
                            .split_inclusive('\n')
                            .filter(|line| {
                                homework_time_override(line).is_some_and(|(key, _)| key != field)
                            })
                            .collect();
                        if !value.is_empty() {
                            times.push_str(&format!("<!-- cnote {field}={value} -->\n"));
                        }
                        json!({"desc": with_homework_times(&text, &times)})
                    }
                }
                "dueComplete" => match value {
                    "true" => json!({"dueComplete": true}),
                    "false" => json!({"dueComplete": false}),
                    _ => bail!("请选择有效的完成标记"),
                },
                "desc" => {
                    let (current, times) = homework_description_parts(description);
                    let (draft, _) = homework_description_parts(value);
                    let matches_current = |previous: &str| {
                        let previous = homework_description_parts(previous).0;
                        previous.replace("\r\n", "\n") == current.replace("\r\n", "\n")
                            || matches!(
                                (serde_json::from_str::<Value>(&previous), serde_json::from_str::<Value>(&current)),
                                (Ok(Value::Object(a)), Ok(Value::Object(b))) if a == b
                            )
                    };
                    anyhow::ensure!(
                        v["previous"].as_str().is_some_and(matches_current)
                            || matches_current(value),
                        "描述已在别处更新，请重新打开作业详情后再编辑"
                    );
                    json!({"desc": with_homework_times(&draft, &times)})
                }
                _ => bail!("此字段不支持修改"),
            };
            Ok(json!({"card":api.put(&format!("/cards/{id}"), &body)?}))
        }
        "delete_card" => {
            let id = identifier(&v)?;
            let _lock = review::Store::open(id)?;
            api.delete(&format!("/cards/{id}"))?;
            Ok(json!({"deleted":true}))
        }
        "review_homework" => review::review(&api, &v),
        "manual_homework_review" => review::manual(&api, &v),
        "publish_homework" => review::retry(&api, &v),
        "reading_source" => crate::homework::reading_source(v["link"].as_str().unwrap_or_default()),
        "homework_attachments" => {
            let id = identifier(&v)?;
            let attachments = api.get(&format!("/cards/{id}/attachments"), &[])?;
            download::plan(
                v["name"].as_str().unwrap_or("作业"),
                v["date"].as_str().unwrap_or_default(),
                &attachments,
            )
        }
        "attachment" | "recognize_image" | "transcribe_audio" => {
            let card = identifier(&v)?;
            let id = v["attachment"].as_str().unwrap_or("");
            anyhow::ensure!(
                id.len() == 24 && id.bytes().all(|b| b.is_ascii_hexdigit()),
                "无效的附件 ID"
            );
            let transcribe = v["op"] == "transcribe_audio";
            let recognize = v["op"] == "recognize_image";
            let data = api.attachment(
                card,
                id,
                transcribe || recognize || v["original"].as_bool().unwrap_or(false),
            )?;
            if recognize {
                let mime = data["mime"].as_str().context("图片格式缺失")?;
                anyhow::ensure!(mime.starts_with("image/"), "此附件不是图片");
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data["base64"].as_str().context("图片数据缺失")?)?;
                crate::ocr::recognize(bytes)
            } else if transcribe {
                let mime = data["mime"].as_str().context("音频格式缺失")?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data["base64"].as_str().context("音频数据缺失")?)?;
                crate::asr::transcribe(bytes, mime)
            } else {
                Ok(data)
            }
        }
        "card" => {
            let id = identifier(&v)?;
            let mut card = api.get(
                &format!("/cards/{id}"),
                &[
                    ("fields", "all"),
                    ("checklists", "all"),
                    ("members", "true"),
                ],
            )?;
            let attachments = api.get(&format!("/cards/{id}/attachments"), &[]);
            let actions = api.get(
                &format!("/cards/{id}/actions"),
                &[("filter", "all"), ("limit", "1000")],
            );
            if let Ok(Value::Array(actions)) = &actions {
                apply_homework_activity(std::slice::from_mut(&mut card), actions);
            }
            Ok(
                json!({"card":card,"attachments":attachments.as_ref().ok(),"actions":actions.as_ref().ok(),"partial":attachments.is_err()||actions.is_err(),"homework_review":review::latest(id).ok().flatten()}),
            )
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn list_cache_reuses_only_fresh_matching_identity_and_refresh_can_bypass() {
        let auth = Credentials {
            key: "key".into(),
            token: "token".into(),
        };
        let other = Credentials {
            key: "key".into(),
            token: "other".into(),
        };
        let mut cache = ListCache {
            entries: Vec::new(),
        };
        let value = json!({"cards": []});
        cache.store("account", &auth, "board", &value);
        let at = cache.entries[0].3;
        assert_eq!(
            cache.read("account", &auth, "board", at),
            Some(value.clone())
        );
        assert!(cache.read("other", &auth, "board", at).is_none());
        assert!(cache.read("account", &other, "board", at).is_none());
        assert!(cache.read("account", &auth, "other-board", at).is_none());
        assert!(
            cache
                .read("account", &auth, "board", at + LIST_CACHE_TTL)
                .is_none()
        );
        assert_eq!(
            cached_list(
                &json!({"cache": true}),
                "account",
                &auth,
                "cache-test",
                || Ok(value.clone())
            )
            .unwrap(),
            value
        );
        assert_eq!(
            cached_list(
                &json!({"cache": true}),
                "account",
                &auth,
                "cache-test",
                || panic!("cache hit must not fetch")
            )
            .unwrap(),
            value
        );
        let fresh = json!({"cards": [{"id": "new"}]});
        assert_eq!(
            cached_list(
                &json!({"cache": false}),
                "account",
                &auth,
                "cache-test",
                || Ok(fresh.clone())
            )
            .unwrap(),
            fresh
        );
        assert!(
            cached_list(
                &json!({"cache": false}),
                "account",
                &auth,
                "cache-test",
                || bail!("offline")
            )
            .is_err()
        );
        assert_eq!(
            cached_list(
                &json!({"cache": true}),
                "account",
                &auth,
                "cache-test",
                || Ok(value.clone())
            )
            .unwrap(),
            value
        );
        drop(InvalidateListCache);
        assert!(
            LIST_CACHE
                .lock()
                .unwrap()
                .read("account", &auth, "cache-test", Instant::now())
                .is_none()
        );
    }
    #[test]
    fn microsoft_links_restore_their_own_credentials_and_hide_assigned_legacy_tokens() {
        let legacy = Credentials {
            key: "legacy-key".into(),
            token: "legacy-token".into(),
        };
        assert!(
            select_credentials("microsoft-a", &AccountLinks::new(), Some(legacy.clone()))
                == Some(legacy.clone())
        );
        let record = AccountLink {
            credentials: legacy.clone(),
            member_id: "trello-a".into(),
            member_name: "家长".into(),
            board_id: "board-a".into(),
            board_name: "嘉嘉".into(),
            cloud_revision: None,
            pending: false,
        };
        let mut records = AccountLinks::from([("microsoft-a".into(), record.clone())]);
        assert!(select_credentials("microsoft-a", &records, None) == Some(legacy.clone()));
        assert!(select_credentials("microsoft-b", &records, Some(legacy.clone())).is_none());
        assert!(select_credentials("", &records, Some(legacy.clone())).is_none());
        let second = Credentials {
            key: "second-key".into(),
            token: "second-token".into(),
        };
        assert!(
            select_credentials("microsoft-b", &records, Some(second.clone()))
                == Some(second.clone())
        );
        records.insert(
            "microsoft-b".into(),
            AccountLink {
                credentials: second.clone(),
                ..record
            },
        );
        let restarted: AccountLinks =
            serde_json::from_str(&serde_json::to_string(&records).unwrap()).unwrap();
        assert!(
            select_credentials("microsoft-a", &restarted, Some(second.clone())) == Some(legacy)
        );
        assert!(select_credentials("microsoft-b", &restarted, None) == Some(second));
    }
    #[test]
    #[ignore = "requires explicit live Trello test credentials"]
    fn live_read_only_api() {
        let auth = Credentials {
            key: std::env::var("TRELLO_API_KEY").expect("TRELLO_API_KEY"),
            token: std::env::var("TRELLO_TOKEN").expect("TRELLO_TOKEN"),
        };
        let api = Api::new(auth).unwrap();
        let boards = api
            .get(
                "/members/me/boards",
                &[("filter", "open"), ("fields", "name,closed,url")],
            )
            .unwrap();
        let boards = boards.as_array().unwrap();
        if let Some(board) = boards.first() {
            let id = board["id"].as_str().unwrap();
            assert!(
                api.get(&format!("/boards/{id}/lists"), &[("filter", "open")])
                    .unwrap()
                    .is_array()
            );
            let cards = api
                .get(
                    &format!("/boards/{id}/cards"),
                    &[("filter", "open"), ("fields", BOARD_CARD_FIELDS)],
                )
                .unwrap();
            assert!(
                cards
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|card| card.get("dateCompleted").is_some())
            );
            if let Some(card) = cards.as_array().unwrap().first() {
                let id = card["id"].as_str().unwrap();
                let full = api
                    .get(
                        &format!("/cards/{id}"),
                        &[
                            ("fields", "all"),
                            ("checklists", "all"),
                            ("members", "true"),
                        ],
                    )
                    .unwrap();
                assert!(full["checklists"].is_array());
                assert!(full["members"].is_array());
                assert!(
                    api.get(&format!("/cards/{id}/attachments"), &[])
                        .unwrap()
                        .is_array()
                );
                assert!(
                    api.get(
                        &format!("/cards/{id}/actions"),
                        &[("filter", "all"), ("limit", "1000")]
                    )
                    .unwrap()
                    .is_array()
                );
            }
        }
    }
    #[test]
    fn attachment_previews_keep_credentials_on_trello_and_reject_active_content() {
        for host in [
            "https://api.trello.com/1/cards/x",
            "https://trello.com/1/cards/x",
        ] {
            assert!(authorized_attachment_host(&url::Url::parse(host).unwrap()));
        }
        let cdn = url::Url::parse("https://trello-attachments.s3.amazonaws.com/file").unwrap();
        assert!(attachment_redirect_allowed(&cdn));
        assert!(!authorized_attachment_host(&cdn));
        for value in [
            "http://trello.com/file",
            "https://trello.com.evil.test/file",
            "https://user@trello.com/file",
            "https://127.0.0.1/file",
            "file:///etc/passwd",
        ] {
            let url = url::Url::parse(value).unwrap();
            assert!(!authorized_attachment_host(&url));
            assert!(!attachment_redirect_allowed(&url));
        }
        assert_eq!(
            preview_mime(&json!({"name":"homework.M4A"})),
            Some("audio/mp4")
        );
        assert_eq!(
            preview_mime(&json!({"name":"script.html","mimeType":"text/html"})),
            None
        );
        assert_eq!(
            preview_mime(&json!({"name":"vector.svg","mimeType":"image/svg+xml"})),
            None
        );
    }
    #[test]
    #[ignore = "requires explicit live Trello test credentials"]
    fn live_attachment_preview() {
        let api = Api::new(Credentials {
            key: std::env::var("TRELLO_API_KEY").unwrap(),
            token: std::env::var("TRELLO_TOKEN").unwrap(),
        })
        .unwrap();
        let boards = api
            .get(
                "/members/me/boards",
                &[("filter", "open"), ("fields", "name")],
            )
            .unwrap();
        let board = boards.as_array().unwrap().first().expect("test board")["id"]
            .as_str()
            .unwrap();
        let cards = api
            .get(
                &format!("/boards/{board}/cards"),
                &[("fields", "name"), ("attachments", "true")],
            )
            .unwrap();
        let (card, attachment) = cards
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find_map(|card| {
                card["attachments"]
                    .as_array()?
                    .iter()
                    .find(|a| {
                        a["isUpload"] == true
                            && preview_mime(a).is_some_and(|m| m.starts_with("image/"))
                    })
                    .map(|a| (card, a))
            })
            .expect("test image attachment");
        let data = api
            .attachment(
                card["id"].as_str().unwrap(),
                attachment["id"].as_str().unwrap(),
                false,
            )
            .unwrap();
        assert!(data["mime"].as_str().unwrap().starts_with("image/"));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data["base64"].as_str().unwrap())
            .unwrap();
        assert!(bytes.len() > 100);
        let original = api
            .attachment(
                card["id"].as_str().unwrap(),
                attachment["id"].as_str().unwrap(),
                true,
            )
            .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(original["base64"].as_str().unwrap())
            .unwrap();
        if let Some(size) = attachment["bytes"].as_u64() {
            assert_eq!(bytes.len() as u64, size);
        }
    }
    #[test]
    fn session_restores_saved_credentials_once_and_retries_keychain_errors() {
        let mut session = Session::default();
        assert!(
            session
                .restore_with(|| anyhow::bail!("keychain locked"))
                .is_err()
        );
        assert!(!session.loaded);
        let saved = Credentials {
            key: "saved-key".into(),
            token: "saved-token".into(),
        };
        assert_eq!(
            session
                .restore_with(|| Ok(Some(saved.clone())))
                .unwrap()
                .unwrap()
                .token,
            "saved-token"
        );
        assert_eq!(
            session
                .restore_with(|| panic!("must reuse session credentials"))
                .unwrap()
                .unwrap()
                .key,
            "saved-key"
        );
        let mut restarted = Session::default();
        assert_eq!(
            restarted
                .restore_with(|| Ok(Some(saved)))
                .unwrap()
                .unwrap()
                .token,
            "saved-token"
        );
    }
    #[test]
    fn authorization_allows_card_updates_and_does_not_include_a_token() {
        let url = url::Url::parse(&authorize(&"a".repeat(32)).unwrap()).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(query.get("scope").unwrap(), "read,write");
        assert_eq!(query.get("name").unwrap(), "CNote");
        assert_eq!(query.get("expiration").unwrap(), "never");
        assert!(!query.contains_key("token"));
        assert!(authorize("bad\"key").is_err());
    }
    #[test]
    fn grade_updates_preserve_other_description_content() {
        assert_eq!(
            description_with_grade("作业类型：数学\n要求：检查", "优").unwrap(),
            "打分结果：优\n作业类型：数学\n要求：检查"
        );
        assert_eq!(
            description_with_grade("说明\r\n 打分结果 : 暂评·良\r\n要求：保留\r\n", "100").unwrap(),
            "打分结果：100\r\n说明\r\n要求：保留\r\n"
        );
        assert_eq!(
            description_with_grade("打分结果：良\n原题", "").unwrap(),
            "原题"
        );
        assert_eq!(
            description_with_grade("打分结果：差", "中").unwrap(),
            "打分结果：中"
        );
        assert_eq!(description_with_grade("", "优").unwrap(), "打分结果：优");
        assert_eq!(description_with_grade("原题", "").unwrap(), "原题");
        assert!(description_with_grade("原题", "优\n覆盖").is_err());
    }

    #[test]
    fn homework_type_and_time_edits_preserve_the_assignment() {
        let time = "<!-- cnote dateCompleted=2026-11-21T08:00:00Z -->\n";
        let original = "打分结果：优\r\n类型: 普通作业\r\n作业内容：\r\n2 + 3 = ___";
        let stored = with_homework_times(original, time);
        assert!(stored.starts_with("打分结果：优\r\n"));
        assert_eq!(homework_description_parts(&stored).0, original);
        let typed = homework_type_description(&stored, "口算").unwrap();
        assert!(typed.contains(time));
        assert_eq!(
            homework_description_parts(&typed).0,
            "打分结果：优\r\n作业类型：口算\r\n作业内容：\r\n2 + 3 = ___"
        );
        let cleared = homework_type_description(&typed, "").unwrap();
        assert_eq!(
            homework_description_parts(&cleared).0,
            "打分结果：优\r\n作业内容：\r\n2 + 3 = ___"
        );
        let graded = description_with_grade(&typed, "100").unwrap();
        assert!(graded.contains(time));
        assert!(graded.starts_with("打分结果：100\r\n"));
        let structured = with_homework_times(r#"{"type":"arithmetic","count":5}"#, time);
        assert_eq!(
            serde_json::from_str::<Value>(&structured).unwrap()["_cnote_dateCompleted"],
            "2026-11-21T08:00:00Z"
        );
        let updated = homework_type_description(&structured, "口算").unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&homework_description_parts(&updated).0).unwrap(),
            json!({"type":"口算","count":5})
        );
    }

    #[test]
    fn homework_activity_uses_tablet_event_time_and_keeps_the_latest_completed_duration() {
        let comment = |card: &str, task: &str, event: &str, at: i64, correction| {
            let heading = if event == "started" {
                "开始做作业"
            } else {
                "作业完成"
            };
            let mut payload =
                json!({"task_id":task, "event":event, "at":at, "correction":correction});
            if event == "completed" {
                payload["started_at"] = json!(at - 70);
                if correction {
                    payload["duration_seconds"] = json!(42);
                }
            }
            json!({"type":"commentCard","data":{
                "card":{"id":card},"text":format!("{heading}\n[homework-activity:v1]\n{payload}")
            }})
        };
        let mut cards = [
            json!({"id":"active"}),
            json!({"id":"finished"}),
            json!({"id":"scheduled","start":"2026-11-21T01:00:00Z"}),
        ];
        apply_homework_activity(
            &mut cards,
            &[
                comment("active", "active", "started", 300, true),
                comment("active", "active", "completed", 200, false),
                comment("finished", "finished", "completed", 400, true),
                comment("finished", "finished", "completed", 300, false),
                comment("finished", "finished", "started", 400, true),
                comment("scheduled", "active", "started", 400, false),
                comment("scheduled", "active", "completed", 500, false),
                json!({"type":"commentCard","data":{"card":{"id":"scheduled"},"text":"开始做作业"}}),
            ],
        );
        assert_eq!(
            cards[0]["homeworkStarted"],
            json!({"at":300,"correction":true})
        );
        assert_eq!(cards[0]["homeworkDurationSeconds"], 70);
        assert_eq!(cards[0]["homeworkCompletedAt"], "1970-01-01T00:03:20Z");
        assert!(cards[1].get("homeworkStarted").is_none());
        assert_eq!(cards[1]["homeworkDurationSeconds"], 42);
        assert_eq!(cards[1]["homeworkCompletedAt"], "1970-01-01T00:06:40Z");
        assert!(cards[2].get("homeworkStarted").is_none());
        assert!(cards[2].get("homeworkDurationSeconds").is_none());
    }
    #[test]
    fn update_request_sends_json_and_handles_read_only_tokens() {
        use std::{
            io::{BufRead, BufReader, Write},
            net::TcpListener,
        };
        for status in [200, 401, 403] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut lines = Vec::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    lines.push(line);
                }
                assert!(lines[0].starts_with("PUT /test HTTP/1.1"));
                assert!(!lines[0].contains("secret"));
                assert!(lines.iter().any(|line| {
                    line.to_lowercase().starts_with("authorization: oauth ")
                        && line.contains("secret-token")
                }));
                let length: usize = lines
                    .iter()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|n| n.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                assert_eq!(
                    serde_json::from_slice::<Value>(&bytes).unwrap(),
                    json!({"desc":"打分结果：优"})
                );
                let body = if status == 200 {
                    r#"{"id":"card","desc":"打分结果：优"}"#
                } else {
                    "secret-token"
                };
                write!(stream,"HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            });
            let api = Api {
                client: crate::http::client().no_proxy().build().unwrap(),
                auth: Credentials {
                    key: "test-key".into(),
                    token: "secret-token".into(),
                },
            };
            let result = api.send_url(
                reqwest::Method::PUT,
                &format!("http://{addr}/test"),
                &[],
                Some(&json!({"desc":"打分结果：优"})),
            );
            if status == 200 {
                assert_eq!(result.unwrap()["desc"], "打分结果：优");
            } else {
                let failure = result.unwrap_err();
                assert_eq!(error_code(&failure), "request_failed");
                let error = failure.to_string();
                assert!(error.contains("重新授权读写权限"));
                assert!(!error.contains("授权已失效"));
                assert!(!error.contains("secret"));
            }
            server.join().unwrap();
        }
    }
    #[test]
    fn delete_accepts_empty_success_and_rejects_read_only_tokens() {
        use std::{
            io::{BufRead, BufReader, Write},
            net::TcpListener,
        };
        for status in [200, 403] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let reader = BufReader::new(stream.try_clone().unwrap());
                let headers: Vec<_> = reader
                    .lines()
                    .map(Result::unwrap)
                    .take_while(|line| !line.is_empty())
                    .collect();
                assert_eq!(headers[0], "DELETE /cards/test HTTP/1.1");
                assert!(
                    headers
                        .iter()
                        .any(|header| header.to_lowercase().starts_with("authorization: oauth "))
                );
                write!(
                    stream,
                    "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            });
            let api = Api {
                client: crate::http::client().no_proxy().build().unwrap(),
                auth: Credentials {
                    key: "key".into(),
                    token: "token".into(),
                },
            };
            let result = api.send_url(
                reqwest::Method::DELETE,
                &format!("http://{addr}/cards/test"),
                &[],
                None,
            );
            if status == 200 {
                assert_eq!(result.unwrap(), Value::Null);
            } else {
                assert!(
                    result
                        .unwrap_err()
                        .downcast_ref::<WriteRejected>()
                        .is_some()
                );
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn request_uses_authorization_header_and_sanitizes_errors() {
        use std::{
            io::{BufRead, BufReader, Write},
            net::TcpListener,
        };
        for status in [200, 401, 403, 429, 500] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut lines = Vec::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    lines.push(line);
                }
                assert!(lines[0].starts_with("GET /test?fields=name "));
                assert!(!lines[0].contains("secret"));
                assert!(
                    lines
                        .iter()
                        .any(|l| l.to_lowercase().starts_with("authorization: oauth ")
                            && l.contains("secret-token"))
                );
                let body = if status == 200 {
                    "{\"name\":\"board\"}"
                } else {
                    "secret-token"
                };
                write!(stream,"HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            });
            let api = Api {
                client: crate::http::client().no_proxy().build().unwrap(),
                auth: Credentials {
                    key: "test-key".into(),
                    token: "secret-token".into(),
                },
            };
            let result = api.get_url(&format!("http://{addr}/test"), &[("fields", "name")]);
            if status == 200 {
                assert_eq!(result.unwrap()["name"], "board");
            } else {
                let failure = result.unwrap_err();
                assert_eq!(
                    error_code(&failure),
                    if status == 401 {
                        "auth_required"
                    } else {
                        "request_failed"
                    }
                );
                let error = failure.to_string();
                assert!(!error.contains("secret"));
                assert!(!error.contains("http://"));
            }
            server.join().unwrap();
        }
    }
}
