//! Native Trello API client. User credentials live only in Keychain.
use anyhow::{Context, Result, bail};
use base64::Engine;
use reqwest::{StatusCode, blocking::Client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io::Read, sync::Mutex, time::Duration};

static AUTH: Mutex<Session> = Mutex::new(Session {
    loaded: false,
    auth: None,
});
#[derive(Default)]
struct Session {
    loaded: bool,
    auth: Option<Credentials>,
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
        self.restore_with(stored)
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
#[derive(Clone, Serialize, Deserialize)]
struct Credentials {
    key: String,
    token: String,
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
        let client = Client::builder()
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
    fn send_url(
        &self,
        method: reqwest::Method,
        url: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Value> {
        let writing = method == reqwest::Method::PUT;
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
            StatusCode::UNAUTHORIZED => return Err(AuthRequired.into()),
            StatusCode::FORBIDDEN if writing => bail!(
                "没有权限修改此 Trello 卡片；旧的只读授权请在关联设置中重新授权读写权限，并确认你有看板编辑权限"
            ),
            StatusCode::FORBIDDEN => bail!("没有权限读取此 Trello 内容，请检查授权或选择其他看板"),
            StatusCode::TOO_MANY_REQUESTS => bail!("Trello 请求过于频繁，请稍后重试"),
            status if !status.is_success() => {
                bail!("Trello 请求失败（HTTP {}），请稍后重试", status.as_u16())
            }
            _ => {}
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
        | "audio/webm" | "video/mp4" | "video/webm" | "video/quicktime" | "application/pdf"
        | "text/plain" | "text/markdown" | "text/csv" | "application/json" => Some(mime),
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
    let newline = if description.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut output = String::new();
    let mut replaced = false;
    for line in description.split_inclusive('\n') {
        let is_grade = line
            .split_once([':', '：'])
            .is_some_and(|(key, _)| key.trim() == "打分结果");
        if !replaced && is_grade {
            replaced = true;
            if !grade.is_empty() {
                output.push_str(&format!("打分结果：{grade}"));
                if line.ends_with('\n') {
                    output.push_str(newline);
                }
            }
        } else {
            output.push_str(line);
        }
    }
    if !replaced && !grade.is_empty() {
        output = format!(
            "打分结果：{grade}{}{description}",
            if description.is_empty() { "" } else { newline }
        );
    }
    Ok(output)
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
    match v["op"].as_str().unwrap_or_default() {
        "status" => {
            let auth = session.auth()?;
            return Ok(
                json!({"connected":auth.is_some(),"key":auth.as_ref().map(|a| a.key.as_str()).unwrap_or(configured_key())}),
            );
        }
        "authorize" => {
            return Ok(json!({"url":authorize(v["key"].as_str().unwrap_or_default().trim())?}));
        }
        "connect" => {
            let auth = credentials(&v)?;
            let api = Api::new(auth)?;
            let member = api.get("/members/me", &[("fields", "fullName,username")])?;
            crate::credential_store::set("trello-auth", &serde_json::to_string(&api.auth)?)?;
            session.loaded = true;
            session.auth = Some(api.auth.clone());
            return Ok(json!({"connected":true,"name":member["fullName"]}));
        }
        "disconnect" => {
            crate::credential_store::remove("trello-auth")?;
            session.loaded = true;
            session.auth = None;
            return Ok(json!({"connected":false}));
        }
        "boards" | "board" | "card" | "attachment" | "update_cell" => {}
        _ => bail!("未知的 Trello 操作"),
    }
    let api = Api::new(session.auth()?.ok_or(AuthRequired)?)?;
    drop(session);
    match v["op"].as_str().unwrap_or_default() {
        "boards" => Ok(
            json!({"boards":api.get("/members/me/boards", &[("filter","open"),("fields","name,closed,url")])?}),
        ),
        "board" => {
            let id = identifier(&v)?;
            Ok(
                json!({"lists":api.get(&format!("/boards/{id}/lists"), &[("filter","open"),("fields","name,closed,pos")])?,"cards":api.get(&format!("/boards/{id}/cards"), &[("filter","open"),("fields","name,desc,due,dueComplete,idList,closed,url,labels,dateLastActivity,dateCompleted")])?}),
            )
        }
        "update_cell" => {
            let id = identifier(&v)?;
            let card = api.get(
                &format!("/cards/{id}"),
                &[("fields", "desc,idBoard,idList")],
            )?;
            let body = match v["field"].as_str().unwrap_or_default() {
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
                    let grade = v["value"].as_str().context("请选择有效评分")?;
                    json!({"desc": description_with_grade(card["desc"].as_str().unwrap_or_default(), grade)?})
                }
                _ => bail!("此字段不支持修改"),
            };
            Ok(json!({"card":api.put(&format!("/cards/{id}"), &body)?}))
        }
        "attachment" => {
            let card = identifier(&v)?;
            let id = v["attachment"].as_str().unwrap_or("");
            anyhow::ensure!(
                id.len() == 24 && id.bytes().all(|b| b.is_ascii_hexdigit()),
                "无效的附件 ID"
            );
            api.attachment(card, id, v["original"].as_bool().unwrap_or(false))
        }
        "card" => {
            let id = identifier(&v)?;
            let card = api.get(
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
            Ok(
                json!({"card":card,"attachments":attachments.as_ref().ok(),"actions":actions.as_ref().ok(),"partial":attachments.is_err()||actions.is_err()}),
            )
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
                    &[
                        ("filter", "open"),
                        (
                            "fields",
                            "name,desc,due,dueComplete,idList,closed,url,labels,dateLastActivity,dateCompleted",
                        ),
                    ],
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
            "说明\r\n打分结果：100\r\n要求：保留\r\n"
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
    fn update_request_sends_json_and_handles_read_only_tokens() {
        use std::{
            io::{BufRead, BufReader, Write},
            net::TcpListener,
        };
        for status in [200, 403] {
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
                client: Client::builder().no_proxy().build().unwrap(),
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
                let error = result.unwrap_err().to_string();
                assert!(error.contains("重新授权读写权限"));
                assert!(!error.contains("secret"));
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
                client: Client::builder().no_proxy().build().unwrap(),
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
