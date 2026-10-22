//! One network thread owns the HTTP connection pool and Keychain-backed OAuth session.
use crate::store::Note;
use anyhow::{Context, Result, bail};
use reqwest::{
    StatusCode,
    blocking::{Client, Response},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, Sender},
    },
    time::{Duration, Instant},
};

const AUTH: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const CLIENT_ID: &str = "e1f582c1-1568-4347-8c5b-1906164e637f";
const SCOPES: &str = "Files.ReadWrite User.Read offline_access";
#[derive(Debug)]
pub enum Job {
    Restore,
    Login,
    Logout,
    List,
    Get(Note),
    Prefetch(Note),
    Put(Note),
    Delete(Note),
}
#[derive(Clone, Debug, Deserialize)]
pub struct Item {
    #[serde(rename = "lastModifiedDateTime", default)]
    pub modified: String,
    pub id: String,
    pub name: String,
    #[serde(rename = "eTag", default)]
    pub etag: String,
    #[serde(default)]
    pub file: Option<serde_json::Value>,
}
#[derive(Debug)]
pub enum Reply {
    Account {
        id: String,
        name: String,
    },
    LoggedOut,
    Device {
        code: String,
        url: String,
    },
    List(Vec<Item>),
    Content {
        sent: Note,
        html: String,
        etag: String,
    },
    Uploaded {
        sent: Note,
        item: Item,
    },
    Deleted(Note),
    Conflict {
        sent: Note,
        html: String,
        etag: String,
    },
    Failed {
        note: Option<String>,
        message: String,
    },
}
#[derive(Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    expires_in: u64,
}
#[derive(Deserialize)]
struct Device {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    #[serde(default = "poll_interval")]
    interval: u64,
}
fn poll_interval() -> u64 {
    5
}
fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn checked(r: Response) -> Result<Response> {
    let status = r.status();
    if !status.is_success() {
        let v: serde_json::Value = r.json().unwrap_or_default();
        let code = v
            .pointer("/error/code")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("error").and_then(|x| x.as_str()))
            .unwrap_or("request_failed");
        bail!("OneDrive 请求失败 ({status}, {code})");
    }
    Ok(r)
}
struct Cloud {
    client: Client,
    tokens: Option<Tokens>,
}
impl Cloud {
    fn entry() -> Result<keyring::Entry> {
        Ok(keyring::Entry::new("com.cyeam.cnote", "onedrive-oauth")?)
    }
    fn store(&mut self, t: TokenResponse) -> Result<()> {
        let refresh = if t.refresh_token.is_empty() {
            self.tokens
                .as_ref()
                .map(|t| t.refresh_token.clone())
                .unwrap_or_default()
        } else {
            t.refresh_token
        };
        let tokens = Tokens {
            access_token: t.access_token,
            refresh_token: refresh,
            expires_at: timestamp() + t.expires_in,
        };
        Self::entry()?
            .set_password(&serde_json::to_string(&tokens)?)
            .context("无法把登录凭据保存到系统钥匙串")?;
        self.tokens = Some(tokens);
        Ok(())
    }
    fn token(&mut self) -> Result<String> {
        let t = self.tokens.as_ref().context("请先登录 OneDrive")?;
        if timestamp() + 90 >= t.expires_at {
            let t: TokenResponse = checked(
                self.client
                    .post(format!("{AUTH}/token"))
                    .form(&[
                        ("client_id", CLIENT_ID),
                        ("grant_type", "refresh_token"),
                        ("refresh_token", t.refresh_token.as_str()),
                        ("scope", SCOPES),
                    ])
                    .send()?,
            )?
            .json()?;
            self.store(t)?;
        }
        Ok(self
            .tokens
            .as_ref()
            .context("请重新登录 OneDrive")?
            .access_token
            .clone())
    }
    fn request(
        &mut self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<reqwest::blocking::RequestBuilder> {
        Ok(self
            .client
            .request(method, format!("{GRAPH}{path}"))
            .bearer_auth(self.token()?))
    }
    fn account(&mut self) -> Result<Reply> {
        let v: serde_json::Value = checked(
            self.request(reqwest::Method::GET, "/me?$select=id,displayName")?
                .send()?,
        )?
        .json()?;
        Ok(Reply::Account {
            id: v["id"].as_str().context("账号缺少 id")?.into(),
            name: v["displayName"].as_str().unwrap_or("OneDrive").into(),
        })
    }
    fn restore(&mut self) -> Result<Reply> {
        match Self::entry()?.get_password() {
            Ok(s) => {
                self.tokens = Some(serde_json::from_str(&s)?);
                self.account()
            }
            Err(keyring::Error::NoEntry) => Ok(Reply::LoggedOut),
            Err(e) => Err(e.into()),
        }
    }
    fn login(
        &mut self,
        gen_id: u64,
        generation: &AtomicU64,
        emit: &impl Fn(Reply),
    ) -> Result<Reply> {
        let d: Device = checked(
            self.client
                .post(format!("{AUTH}/devicecode"))
                .form(&[("client_id", CLIENT_ID), ("scope", SCOPES)])
                .send()?,
        )?
        .json()?;
        emit(Reply::Device {
            code: d.user_code,
            url: d.verification_uri,
        });
        let until = Instant::now() + Duration::from_secs(d.expires_in.min(1200));
        let mut interval = d.interval.max(1);
        while Instant::now() < until {
            // Check cancellation promptly even during Microsoft's polling interval.
            for _ in 0..interval * 5 {
                if generation.load(Ordering::SeqCst) != gen_id {
                    bail!("登录已取消");
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            let r = self
                .client
                .post(format!("{AUTH}/token"))
                .form(&[
                    ("client_id", CLIENT_ID),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("device_code", d.device_code.as_str()),
                ])
                .send()?;
            if r.status().is_success() {
                let token = r.json()?;
                if generation.load(Ordering::SeqCst) != gen_id {
                    bail!("登录已取消");
                }
                self.store(token)?;
                return self.account();
            }
            let v: serde_json::Value = r.json()?;
            match v["error"].as_str() {
                Some("authorization_pending") => {}
                Some("slow_down") => interval += 5,
                _ => bail!("Microsoft 登录未完成，请重新登录"),
            }
        }
        bail!("登录码已过期，请重新登录")
    }
    fn list(&mut self) -> Result<Vec<Item>> {
        let mut path =
            "/me/drive/root:/Notes:/children?$select=id,name,eTag,file,lastModifiedDateTime&$top=200".to_string();
        let mut items = Vec::new();
        loop {
            let r = self.request(reqwest::Method::GET, &path)?.send()?;
            if r.status() == StatusCode::NOT_FOUND {
                return Ok(items);
            }
            let v: serde_json::Value = checked(r)?.json()?;
            let page: Vec<Item> = serde_json::from_value(v["value"].clone())?;
            items.extend(
                page.into_iter()
                    .filter(|n| n.file.is_some() && n.name.ends_with(".html")),
            );
            match v["@odata.nextLink"].as_str() {
                Some(next) => {
                    path = next
                        .strip_prefix(GRAPH)
                        .context("拒绝不可信分页地址")?
                        .into();
                }
                None => break,
            }
        }
        Ok(items)
    }
    fn download(&mut self, id: &str) -> Result<(String, String)> {
        let token = self.token()?;
        download_with_token(&self.client, &token, id, Duration::from_secs(25))
    }
    fn put(&mut self, n: Note) -> Result<Reply> {
        let r = if let Some(id) = &n.remote_id {
            let etag = n
                .etag
                .as_ref()
                .filter(|e| !e.is_empty())
                .context("缺少版本信息，请先刷新云端笔记")?;
            self.request(
                reqwest::Method::PUT,
                &format!("/me/drive/items/{}/content", segment(id)),
            )?
            .header("If-Match", etag)
            .header("Content-Type", "text/html; charset=utf-8")
            .body(n.html.clone())
            .send()?
        } else {
            self.ensure_folder()?;
            let name = format!("{}--{}.html", n.title, &n.id[..8]);
            // Recover a create whose response was lost. Never overwrite a same-name cloud note.
            let path = format!("/me/drive/root:/Notes/{}", segment(&name));
            let exists = self.request(reqwest::Method::GET, &path)?.send()?;
            if exists.status().is_success() {
                let item: Item = exists.json()?;
                let (html, etag) = self.download(&item.id)?;
                return if html == n.html {
                    Ok(Reply::Uploaded { sent: n, item })
                } else {
                    let mut sent = n;
                    sent.remote_id = Some(item.id);
                    Ok(Reply::Conflict { sent, html, etag })
                };
            }
            if exists.status() != StatusCode::NOT_FOUND {
                checked(exists)?;
            }
            self.request(
                reqwest::Method::PUT,
                &format!("{path}:/content?@microsoft.graph.conflictBehavior=fail"),
            )?
            .header("Content-Type", "text/html; charset=utf-8")
            .body(n.html.clone())
            .send()?
        };
        if matches!(
            r.status(),
            StatusCode::PRECONDITION_FAILED | StatusCode::CONFLICT
        ) {
            let id = n
                .remote_id
                .as_deref()
                .context("同名笔记已存在，请刷新后重试")?;
            let (html, etag) = self.download(id)?;
            return Ok(Reply::Conflict {
                sent: n,
                html,
                etag,
            });
        }
        let item = checked(r)?.json()?;
        Ok(Reply::Uploaded { sent: n, item })
    }
    fn ensure_folder(&mut self) -> Result<()> {
        let r = self
            .request(reqwest::Method::GET, "/me/drive/root:/Notes")?
            .send()?;
        if r.status() == StatusCode::NOT_FOUND {
            let r=self.request(reqwest::Method::POST,"/me/drive/root/children")?.json(&serde_json::json!({"name":"Notes","folder":{},"@microsoft.graph.conflictBehavior":"fail"})).send()?;
            if r.status() != StatusCode::CONFLICT {
                checked(r)?;
            }
        } else {
            checked(r)?;
        }
        Ok(())
    }
    fn run(&mut self, job: Job) -> Result<Reply> {
        match job {
            Job::Restore => self.restore(),
            Job::Logout => {
                self.tokens = None;
                match Self::entry()?.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => {}
                    Err(e) => return Err(e.into()),
                };
                Ok(Reply::LoggedOut)
            }
            Job::List => Ok(Reply::List(self.list()?)),
            Job::Get(n) => {
                let (html, etag) =
                    self.download(n.remote_id.as_deref().context("本地笔记尚未上传")?)?;
                Ok(Reply::Content {
                    sent: n,
                    html,
                    etag,
                })
            }
            Job::Put(n) => self.put(n),
            Job::Delete(n) => {
                let id = n.remote_id.as_deref().context("笔记没有云端 id")?;
                let r = self
                    .request(
                        reqwest::Method::DELETE,
                        &format!("/me/drive/items/{}", segment(id)),
                    )?
                    .header("If-Match", n.etag.as_ref().context("缺少版本信息")?)
                    .send()?;
                if r.status() == StatusCode::PRECONDITION_FAILED {
                    let (html, etag) = self.download(id)?;
                    return Ok(Reply::Conflict {
                        sent: n,
                        html,
                        etag,
                    });
                }
                if r.status() != StatusCode::NOT_FOUND {
                    checked(r)?;
                }
                Ok(Reply::Deleted(n))
            }
            Job::Login | Job::Prefetch(_) => unreachable!(),
        }
    }
}
fn download_with_token(
    client: &Client,
    token: &str,
    id: &str,
    timeout: Duration,
) -> Result<(String, String)> {
    let path = format!("{GRAPH}/me/drive/items/{}", segment(id));
    let request = |url: &str| checked(client.get(url).bearer_auth(token).timeout(timeout).send()?);
    // Keep the metadata/body/metadata ETag check for foreground and background reads.
    for _ in 0..3 {
        let before: Item = request(&path)?.json()?;
        let response = request(&format!("{path}/content"))?;
        if response
            .content_length()
            .is_some_and(|size| size > 20 * 1024 * 1024)
        {
            bail!("云端笔记超过 20 MB");
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        response
            .take(20 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 20 * 1024 * 1024 {
            bail!("云端笔记超过 20 MB");
        }
        let after: Item = request(&path)?.json()?;
        if before.etag == after.etag && !after.etag.is_empty() {
            return Ok((String::from_utf8(bytes)?, after.etag));
        }
    }
    bail!("笔记正在其他设备上修改，请稍后重试")
}
fn segment(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
pub fn spawn(
    rx: Receiver<(u64, Job)>,
    tx: Sender<crate::engine::Command>,
    generation: Arc<AtomicU64>,
) {
    std::thread::Builder::new()
        .name("cnote-network".into())
        .spawn(move || {
            let client = match Client::builder()
                .timeout(Duration::from_secs(25))
                .connect_timeout(Duration::from_secs(10))
                .user_agent(concat!("CNote/", env!("CNOTE_APP_VERSION")))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(crate::engine::Command::Network(
                        0,
                        Box::new(Reply::Failed {
                            note: None,
                            message: e.to_string(),
                        }),
                    ));
                    return;
                }
            };
            let (prefetch_tx, prefetch_rx) =
                std::sync::mpsc::sync_channel::<(u64, Note, String)>(1);
            let prefetch_client = client.clone();
            let prefetch_generation = generation.clone();
            let replies = tx.clone();
            std::thread::Builder::new()
                .name("cnote-prefetch".into())
                .spawn(move || {
                    while let Ok((epoch, note, token)) = prefetch_rx.recv() {
                        if prefetch_generation.load(Ordering::SeqCst) != epoch {
                            continue;
                        }
                        let result = note
                            .remote_id
                            .as_deref()
                            .context("缺少云端笔记 ID")
                            .and_then(|id| {
                                download_with_token(
                                    &prefetch_client,
                                    &token,
                                    id,
                                    Duration::from_secs(8),
                                )
                            });
                        let reply = match result {
                            Ok((html, etag)) => Reply::Content {
                                sent: note,
                                html,
                                etag,
                            },
                            Err(error) => Reply::Failed {
                                note: Some(note.id),
                                message: error.to_string(),
                            },
                        };
                        let _ = replies
                            .send(crate::engine::Command::Prefetched(epoch, Box::new(reply)));
                    }
                })
                .expect("start prefetch worker");
            let mut c = Cloud {
                client,
                tokens: None,
            };
            while let Ok((epoch, job)) = rx.recv() {
                if generation.load(Ordering::SeqCst) != epoch {
                    continue;
                }
                if let Job::Prefetch(note) = job {
                    let id = note.id.clone();
                    let result = c.token().and_then(|token| {
                        prefetch_tx
                            .try_send((epoch, note, token))
                            .map_err(|_| anyhow::anyhow!("预取队列忙碌"))
                    });
                    if let Err(error) = result {
                        let _ = tx.send(crate::engine::Command::Prefetched(
                            epoch,
                            Box::new(Reply::Failed {
                                note: Some(id),
                                message: error.to_string(),
                            }),
                        ));
                    }
                    continue;
                }
                let note = match &job {
                    Job::Get(n) | Job::Put(n) | Job::Delete(n) => Some(n.id.clone()),
                    _ => None,
                };
                let emit = |reply| {
                    let _ = tx.send(crate::engine::Command::Network(epoch, Box::new(reply)));
                };
                use crate::analytics::{Event as AnalyticsEvent, Operation, Outcome};
                let operation = match &job {
                    Job::Restore => Operation::Restore,
                    Job::Login => Operation::Login,
                    Job::Logout => Operation::Logout,
                    Job::List => Operation::List,
                    Job::Get(_) | Job::Prefetch(_) => Operation::Download,
                    Job::Put(_) => Operation::Upload,
                    Job::Delete(_) => Operation::Delete,
                };
                let started = Instant::now();
                let result = if matches!(job, Job::Login) {
                    c.login(epoch, &generation, &emit)
                } else {
                    c.run(job)
                };
                if generation.load(Ordering::SeqCst) == epoch {
                    let outcome = match &result {
                        Ok(Reply::Conflict { .. }) => Outcome::Conflict,
                        Ok(Reply::LoggedOut) if matches!(operation, Operation::Restore) => {
                            Outcome::LoggedOut
                        }
                        Ok(_) => Outcome::Success,
                        Err(_) => Outcome::Failure,
                    };
                    crate::analytics::capture(AnalyticsEvent::Cloud {
                        operation,
                        outcome,
                        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    });
                }
                emit(result.unwrap_or_else(|e| Reply::Failed {
                    note,
                    message: format!("{e:#}"),
                }));
            }
        })
        .expect("start network worker");
}
