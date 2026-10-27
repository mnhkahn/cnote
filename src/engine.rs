use crate::{
    cloud::{self, Job, Reply},
    store::{self, Note, Store, Summary},
    theme::Theme,
};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Sender},
    },
    time::{Duration, Instant},
};

pub enum Command {
    Web(Value),
    SerializedChange(String),
    Network(u64, Box<Reply>),
    Prefetched(u64, Box<Reply>),
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Theme {
        theme: Theme,
    },
    State {
        cache_generation: u64,
        cache_account: String,
        intent: u64,
        notes: Vec<Summary>,
        selected: Option<String>,
        account: String,
        authenticated: bool,
        status: String,
    },
    Load {
        intent: u64,
        id: String,
        title: String,
        html: String,
    },
    Preload {
        generation: u64,
        script: String,
    },
    Selected {
        id: String,
        intent: u64,
    },
    Title {
        id: String,
        title: String,
    },
    Saved {
        id: String,
        seq: u64,
        title: String,
    },
    Dialog {
        kind: String,
        data: Value,
    },
    Error {
        message: String,
    },
    SaveFailed {
        id: String,
        seq: u64,
        message: String,
    },
    ToolState {
        state: Value,
    },
    ToolSaved {
        seq: u64,
    },
    ToolSaveFailed {
        seq: u64,
        message: String,
    },
    ToolExport {
        filename: String,
        bytes: Vec<u8>,
    },
    Closed,
}
pub struct Handle {
    pub tx: Sender<Command>,
    pub events: async_channel::Receiver<Event>,
}
struct Engine {
    intent: u64,
    editing: HashSet<String>,
    db: Store,
    tx: Sender<(u64, Job)>,
    events: async_channel::Sender<Event>,
    generation: Arc<AtomicU64>,
    account: String,
    name: String,
    authenticated: bool,
    selected: Option<String>,
    status: String,
    inflight: HashSet<String>,
    cloud: HashMap<String, (String, String)>,
    approved: HashMap<String, i64>,
    retry: HashMap<String, Instant>,
    asked: HashSet<(String, i64)>,
    next_sync: Instant,
    warm_queue: VecDeque<String>,
    warmed: HashSet<String>,
    prefetch_queue: VecDeque<String>,
    prefetching: Option<String>,
}
impl Engine {
    fn emit(&self, e: Event) {
        let _ = self.events.send_blocking(e);
    }
    fn restore_theme(&self) {
        let theme = self
            .db
            .setting("theme")
            .ok()
            .flatten()
            .and_then(|value| Theme::parse(&value))
            .unwrap_or_default();
        self.emit(Event::Theme { theme });
    }
    fn state(&self) -> Result<()> {
        self.emit(Event::State {
            cache_generation: self.generation.load(Ordering::SeqCst),
            cache_account: self.account.clone(),
            intent: self.intent,
            notes: self.db.list(&self.account)?,
            selected: self.selected.clone(),
            account: self.name.clone(),
            authenticated: self.authenticated,
            status: self.status.clone(),
        });
        Ok(())
    }
    fn job(&self, j: Job) {
        let _ = self.tx.send((self.generation.load(Ordering::SeqCst), j));
    }
    fn show(&mut self, id: &str) -> Result<()> {
        self.show_cached(id, false)
    }
    fn show_cached(&mut self, id: &str, cached: bool) -> Result<()> {
        let n = self.db.get(id)?;
        anyhow::ensure!(
            !n.deleted && (n.account.is_empty() || n.account == self.account),
            "笔记不属于当前账号"
        );
        self.selected = Some(id.into());
        if !cached && (n.remote_id.is_none() || n.etag.is_some() || n.dirty) {
            self.emit(Event::Load {
                intent: self.intent,
                id: n.id.clone(),
                title: n.title.clone(),
                html: n.html.clone(),
            });
        }
        if n.conflict && self.cloud.contains_key(id) {
            self.emit(Event::Dialog {
                kind: "conflict".into(),
                data: json!({"id":n.id}),
            });
        } else if self.authenticated && n.remote_id.is_some() {
            self.job(Job::Get(n));
        }
        self.emit(Event::Selected {
            id: id.into(),
            intent: self.intent,
        });
        self.plan_warmup()?;
        Ok(())
    }
    fn plan_warmup(&mut self) -> Result<()> {
        let notes = self.db.list(&self.account)?;
        let selected = notes
            .iter()
            .position(|n| Some(n.id.as_str()) == self.selected.as_deref())
            .unwrap_or(0);
        let mut indices = Vec::with_capacity(9);
        if !notes.is_empty() {
            indices.push(selected);
        }
        for offset in 1..9 {
            if let Some(index) = selected.checked_sub(offset) {
                indices.push(index);
            }
            if selected + offset < notes.len() {
                indices.push(selected + offset);
            }
            if indices.len() >= 9 {
                break;
            }
        }
        let ids: HashSet<_> = indices
            .iter()
            .take(9)
            .map(|&i| notes[i].id.clone())
            .collect();
        self.warmed.retain(|id| ids.contains(id));
        self.warm_queue = indices
            .into_iter()
            .take(9)
            .map(|i| notes[i].id.clone())
            .filter(|id| Some(id.as_str()) != self.selected.as_deref() && !self.warmed.contains(id))
            .collect();
        Ok(())
    }
    fn preload(&self, note: &Note) {
        if note.html.len() > 512 * 1024
            || (note.remote_id.is_some() && note.etag.is_none() && !note.dirty)
        {
            return;
        }
        let generation = self.generation.load(Ordering::SeqCst);
        // Serialize on the storage worker; the UI only forwards the prepared script.
        let data = json!({"type":"preload","generation":generation,"id":note.id,"title":note.title,"html":note.html});
        self.emit(Event::Preload {
            generation,
            script: format!("window.cnote&&cnote.receive({data})"),
        });
    }
    fn warm_next(&mut self) -> Result<()> {
        if let Some(id) = self.warm_queue.pop_front() {
            let Ok(note) = self.db.get(&id) else {
                return Ok(());
            };
            if !note.deleted && (note.account.is_empty() || note.account == self.account) {
                self.preload(&note);
                self.warmed.insert(id);
            }
        }
        Ok(())
    }
    fn prefetch_next(&mut self) -> Result<()> {
        if !self.authenticated || self.prefetching.is_some() {
            return Ok(());
        }
        while let Some(id) = self.prefetch_queue.pop_front() {
            let Ok(mut note) = self.db.get(&id) else {
                continue;
            };
            if note.deleted
                || note.dirty
                || note.conflict
                || note.account != self.account
                || self.editing.contains(&id)
                || self.selected.as_deref() == Some(id.as_str())
            {
                continue;
            }
            note.html.clear();
            note.baseline.clear();
            self.prefetching = Some(id);
            self.job(Job::Prefetch(note));
            break;
        }
        Ok(())
    }
    fn prefetched(&mut self, epoch: u64, reply: Reply) -> Result<()> {
        if epoch != self.generation.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.prefetching = None;
        if let Reply::Content { sent, html, etag } = reply {
            let Ok(mut note) = self.db.get(&sent.id) else {
                return Ok(());
            };
            if note.deleted
                || note.dirty
                || note.conflict
                || self.editing.contains(&note.id)
                || note.account != self.account
                || note.remote_id != sent.remote_id
                || note.revision != sent.revision
                || note.etag != sent.etag
            {
                return Ok(());
            }
            note.html = html.clone();
            note.baseline = html;
            note.etag = Some(etag);
            self.db.put(&note)?;
            self.emit(Event::Title {
                id: note.id.clone(),
                title: self.db.display_title(&note.id)?,
            });
            if self.selected.as_deref() == Some(note.id.as_str()) {
                self.emit(Event::Load {
                    intent: self.intent,
                    id: note.id,
                    title: note.title,
                    html: note.html,
                });
            } else {
                self.preload(&note);
            }
        }
        Ok(())
    }
    fn reset_cache(&mut self) {
        self.warm_queue.clear();
        self.warmed.clear();
        self.prefetch_queue.clear();
        self.prefetching = None;
    }
    fn refresh(&mut self) {
        if self.authenticated {
            self.job(Job::List);
            if let Some(id) = &self.selected
                && let Ok(n) = self.db.get(id)
                && n.remote_id.is_some()
            {
                self.job(Job::Get(n));
            }
            self.retry.clear();
            self.next_sync = Instant::now();
        }
    }
    fn sync(&mut self) -> Result<()> {
        if !self.authenticated || Instant::now() < self.next_sync {
            return Ok(());
        }
        self.next_sync = Instant::now() + Duration::from_secs(2);
        for mut n in self.db.pending(&self.account)? {
            if self.inflight.contains(&n.id)
                || self.retry.get(&n.id).is_some_and(|t| *t > Instant::now())
            {
                continue;
            }
            if !n.deleted
                && store::large_change(&n.baseline, &n.html)
                && self.approved.get(&n.id) != Some(&n.revision)
            {
                if self.asked.insert((n.id.clone(), n.revision)) {
                    self.emit(Event::Dialog {
                        kind: "large_change".into(),
                        data: json!({"id":n.id,"title":n.title,"revision":n.revision}),
                    });
                }
                continue;
            }
            if n.account.is_empty() {
                n.account = self.account.clone();
                self.db.put(&n)?;
            }
            self.inflight.insert(n.id.clone());
            if n.deleted {
                if n.remote_id.is_some() {
                    self.job(Job::Delete(n));
                } else {
                    self.inflight.remove(&n.id);
                    self.db.remove(&n.id)?;
                }
            } else {
                self.job(Job::Put(n));
            }
        }
        Ok(())
    }
    fn dispatch(&mut self, v: Value) -> Result<()> {
        let saving = v["type"] == "change";
        let tool_saving = v["type"] == "tool_save";
        let resolving = v["type"] == "resolve";
        let id = v["id"].as_str().unwrap_or_default().to_owned();
        let seq = v["seq"].as_u64().unwrap_or(0);
        match self.web(v) {
            Err(err) if resolving => {
                self.emit(Event::Dialog {
                    kind: "conflict_result".into(),
                    data: json!({"id":id,"ok":false,"message":format!("{err:#}")}),
                });
                Ok(())
            }
            Err(err) if tool_saving => {
                self.emit(Event::ToolSaveFailed {
                    seq,
                    message: format!("{err:#}"),
                });
                Ok(())
            }
            Err(err) if saving => {
                self.emit(Event::SaveFailed {
                    id,
                    seq,
                    message: format!("{err:#}"),
                });
                Ok(())
            }
            result => result,
        }
    }
    fn web(&mut self, v: Value) -> Result<()> {
        let id = v["id"].as_str().unwrap_or_default();
        if matches!(
            v["type"].as_str(),
            Some("open" | "new" | "delete" | "login" | "logout")
        ) {
            self.intent = self.intent.max(v["intent"].as_u64().unwrap_or(self.intent));
        }
        match v["type"].as_str().unwrap_or_default() {
            "tool_ready" => {
                let state = self
                    .db
                    .setting("tool_state")?
                    .map(|s| serde_json::from_str(&s))
                    .transpose()?
                    .unwrap_or(Value::Null);
                self.emit(Event::ToolState { state });
            }
            "tool_save" => {
                anyhow::ensure!(v["state"].is_object(), "工具草稿格式错误");
                let state = serde_json::to_string(&v["state"])?;
                anyhow::ensure!(state.len() <= 20 * 1024 * 1024, "工具草稿超过 20 MB");
                self.db.set_setting("tool_state", &state)?;
                self.emit(Event::ToolSaved {
                    seq: v["seq"].as_u64().unwrap_or(0),
                });
            }
            "tool_export" => {
                use base64::Engine as _;
                let filename = v["filename"].as_str().context("缺少导出文件名")?;
                anyhow::ensure!(
                    filename.len() < 100 && !filename.contains(['/', '\\', ':']),
                    "导出文件名无效"
                );
                let data = v["data"].as_str().context("缺少导出数据")?;
                anyhow::ensure!(data.len() <= 28 * 1024 * 1024, "导出文件超过 20 MB");
                let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
                anyhow::ensure!(bytes.len() <= 20 * 1024 * 1024, "导出文件超过 20 MB");
                self.emit(Event::ToolExport {
                    filename: filename.into(),
                    bytes,
                });
            }
            "ready" => {
                if let Some(id) = self
                    .selected
                    .clone()
                    .or(self.db.first_cached_id(&self.account)?)
                {
                    self.show(&id)?;
                }
                self.plan_warmup()?;
                self.state()?;
            }
            "open" => self.show_cached(id, v["cached"].as_bool().unwrap_or(false))?,
            "editing" => {
                self.editing.insert(id.into());
            }
            "settled" => {
                self.editing.remove(id);
            }
            "new" => {
                let n = self
                    .db
                    .create(v["title"].as_str().unwrap_or("未命名笔记"), &self.account)?;
                crate::analytics::capture(crate::analytics::Event::NoteCreated);
                self.show(&n.id)?;
                self.state()?;
            }
            "theme" => {
                let theme =
                    Theme::parse(v["value"].as_str().unwrap_or_default()).context("未知主题")?;
                self.db.set_setting("theme", theme.as_str())?;
                self.emit(Event::Theme { theme });
            }
            "change" => {
                self.db.save_html(
                    id,
                    &self.account,
                    v["html"].as_str().context("缺少笔记内容")?,
                )?;
                self.status = "已保存到本机".into();
                self.emit(Event::Saved {
                    id: id.into(),
                    seq: v["seq"].as_u64().unwrap_or(0),
                    title: self.db.display_title(id)?,
                });
                self.next_sync = Instant::now() + Duration::from_secs(2);
            }
            "save" => {
                self.retry.clear();
                self.next_sync = Instant::now();
                self.sync()?;
                self.refresh();
                self.status = if self.authenticated {
                    "正在同步到 OneDrive…"
                } else {
                    "已保存到本机 · 登录后自动同步"
                }
                .into();
                self.state()?;
            }
            "refresh" => self.refresh(),
            "login" => {
                self.generation.fetch_add(1, Ordering::SeqCst);
                self.reset_cache();
                self.authenticated = false;
                self.inflight.clear();
                self.status = "正在请求 Microsoft 登录码…".into();
                self.job(Job::Login);
                self.state()?;
            }
            "logout" => {
                self.generation.fetch_add(1, Ordering::SeqCst);
                self.reset_cache();
                self.job(Job::Logout);
                self.authenticated = false;
                self.account.clear();
                self.name.clear();
                self.inflight.clear();
                self.cloud.clear();
                self.approved.clear();
                self.asked.clear();
                self.selected = None;
                self.db.set_setting("account", "")?;
                self.db.set_setting("name", "")?;
                self.db.set_setting("selected", "")?;
                self.emit(Event::Load {
                    intent: self.intent,
                    id: String::new(),
                    title: String::new(),
                    html: String::new(),
                });
                self.status = "已注销；原账号草稿保留在本机".into();
                self.state()?;
            }
            "delete" => {
                let mut n = self.db.get(id)?;
                anyhow::ensure!(
                    n.account.is_empty() || n.account == self.account,
                    "账号不匹配"
                );
                anyhow::ensure!(
                    n.remote_id.is_none() || n.etag.as_ref().is_some_and(|s| !s.is_empty()),
                    "正在读取云端版本，请稍后再删除"
                );
                let newly_deleted = !n.deleted;
                n.deleted = true;
                n.dirty = true;
                self.db.put(&n)?;
                if newly_deleted {
                    crate::analytics::capture(crate::analytics::Event::NoteDeleted);
                }
                if self.selected.as_deref() == Some(id) {
                    self.selected = None;
                    self.emit(Event::Load {
                        intent: self.intent,
                        id: String::new(),
                        title: String::new(),
                        html: String::new(),
                    });
                }
                if !self.authenticated && n.remote_id.is_none() {
                    self.db.remove(id)?;
                }
                self.state()?;
                self.next_sync = Instant::now();
            }
            "approve" => {
                let n = self.db.get(id)?;
                anyhow::ensure!(
                    n.account.is_empty() || n.account == self.account,
                    "账号已切换，请重新打开笔记"
                );
                if v["revision"].as_i64() == Some(n.revision) {
                    self.approved.insert(id.into(), n.revision);
                    self.next_sync = Instant::now();
                }
            }
            "conflict_view" => {
                let n = self.db.get(id)?;
                anyhow::ensure!(
                    n.account.is_empty() || n.account == self.account,
                    "账号已切换，请重新打开笔记"
                );
                if n.conflict {
                    if let Some((html, etag)) = self.cloud.get(id) {
                        self.emit(Event::Dialog {
                            kind: "conflict_view".into(),
                            data: json!({"id":n.id,"title":n.title,"local":n.html,"revision":n.revision,"cloud":html,"etag":etag}),
                        });
                    } else if self.authenticated {
                        self.job(Job::Get(n));
                    }
                }
            }
            "resolve" => {
                let owner = self.db.get(id)?;
                anyhow::ensure!(
                    owner.account.is_empty() || owner.account == self.account,
                    "账号已切换，请重新打开笔记"
                );
                let choice = v["choice"].as_str().unwrap_or_default();
                anyhow::ensure!(
                    ["cloud", "mine", "merge"].contains(&choice),
                    "未知冲突处理方式"
                );
                if let Some(revision) = v["revision"].as_i64() {
                    anyhow::ensure!(
                        revision == owner.revision,
                        "本地笔记已更新，请重新打开冲突对比"
                    );
                }
                if let Some(etag) = v["etag"].as_str() {
                    anyhow::ensure!(
                        self.cloud
                            .get(id)
                            .is_some_and(|(_, current)| current == etag),
                        "云端版本已更新，请重新打开冲突对比"
                    );
                }
                let merged = if choice == "merge" {
                    Some(v["html"].as_str().context("缺少合并内容")?.to_owned())
                } else {
                    None
                };
                if let Some((html, etag)) = self.cloud.get(id).cloned() {
                    let mut n = self.db.get(id)?;
                    n.baseline = html.clone();
                    n.etag = Some(etag);
                    n.conflict = false;
                    n.deleted = false;
                    if v["choice"] == "cloud" {
                        n.html = html;
                        n.dirty = false;
                        n.revision += 1;
                    } else {
                        if let Some(html) = merged {
                            n.html = html;
                            n.revision += 1;
                        }
                        n.dirty = true;
                    }
                    self.db.put(&n)?;
                    self.cloud.remove(id);
                    if n.dirty {
                        self.approved.insert(id.into(), n.revision);
                    }
                    let result = json!({"id":n.id,"ok":true,"choice":choice,"html":n.html,"pending_sync":n.dirty});
                    if self.selected.as_deref() == Some(id) {
                        self.emit(Event::Load {
                            intent: self.intent,
                            id: n.id,
                            title: n.title,
                            html: n.html,
                        });
                    } else {
                        self.preload(&n);
                    }
                    self.retry.remove(id);
                    self.next_sync = Instant::now();
                    self.status = match choice {
                        "cloud" => "已使用云端版本 · 已保存到本机",
                        "mine" => "已保留本地版本 · 已保存到本机，等待同步到 OneDrive",
                        _ => "已保存合并结果到本机 · 等待同步到 OneDrive",
                    }
                    .into();
                    self.state()?;
                    self.emit(Event::Dialog {
                        kind: "conflict_result".into(),
                        data: result,
                    });
                } else {
                    anyhow::bail!("冲突版本已失效，请重新打开冲突对比");
                }
            }
            "close" => {
                self.db
                    .set_setting("selected", self.selected.as_deref().unwrap_or(""))?;
                self.emit(Event::Closed);
            }
            _ => {}
        }
        Ok(())
    }
    fn conflict(&mut self, mut n: Note, html: String, etag: String) -> Result<()> {
        n.conflict = true;
        n.deleted = false;
        // A create recovered from a lost HTTP response may already have a remote ID.
        self.db.put(&n)?;
        self.cloud.insert(n.id.clone(), (html, etag));
        self.emit(Event::Dialog {
            kind: "conflict".into(),
            data: json!({"id":n.id}),
        });
        self.status = "检测到版本冲突，草稿已保留".into();
        Ok(())
    }
    fn network(&mut self, epoch: u64, r: Reply) -> Result<()> {
        if epoch != self.generation.load(Ordering::SeqCst) {
            return Ok(());
        }
        match r {
            Reply::Device { code, url } => self.emit(Event::Dialog {
                kind: "login".into(),
                data: json!({"code":code,"url":url}),
            }),
            Reply::Account { id, name } => {
                let changed = self.account != id;
                if changed {
                    self.generation.fetch_add(1, Ordering::SeqCst);
                    self.reset_cache();
                }
                self.account = id;
                self.name = name;
                self.authenticated = true;
                self.db.set_setting("account", &self.account)?;
                self.db.set_setting("name", &self.name)?;
                self.status = "OneDrive 已连接".into();
                if changed {
                    self.selected = None;
                    self.emit(Event::Load {
                        intent: self.intent,
                        id: String::new(),
                        title: String::new(),
                        html: String::new(),
                    });
                }
                self.emit(Event::Dialog {
                    kind: "login_done".into(),
                    data: Value::Null,
                });
                self.refresh();
            }
            Reply::LoggedOut => {
                self.authenticated = false;
                self.status = "离线模式 · 笔记保存在本机".into();
            }
            Reply::List(mut items) => {
                items.sort_by(|a, b| b.modified.cmp(&a.modified));
                self.prefetch_queue.clear();
                let ids: HashSet<_> = items.iter().map(|n| n.id.clone()).collect();
                for item in items {
                    if let Some((id, etag, dirty)) = self.db.update_remote_metadata(
                        &self.account,
                        &item.id,
                        &display_title(&item.name),
                        remote_modified(&item.modified),
                    )? {
                        if !dirty && etag.as_deref() != Some(item.etag.as_str()) {
                            if self.selected.as_deref() == Some(id.as_str()) {
                                self.job(Job::Get(self.db.get(&id)?));
                            } else {
                                self.prefetch_queue.push_back(id);
                            }
                        }
                    } else {
                        let id = uuid::Uuid::new_v4().to_string();
                        self.db.put(&Note {
                            id: id.clone(),
                            account: self.account.clone(),
                            remote_id: Some(item.id),
                            title: display_title(&item.name),
                            html: String::new(),
                            baseline: String::new(),
                            etag: None,
                            revision: 0,
                            dirty: false,
                            deleted: false,
                            conflict: false,
                            modified: remote_modified(&item.modified),
                        })?;
                        self.prefetch_queue.push_back(id);
                    }
                }
                // Preserve any locally changed note that vanished from the cloud as a conflict.
                for (id, remote, dirty) in self.db.remote_entries(&self.account)? {
                    if !ids.contains(&remote) && !self.inflight.contains(&id) {
                        if dirty {
                            self.db.mark_conflict(&id)?;
                            self.status = "云端笔记已移除；本地草稿保留，可导出 HTML".into();
                        } else {
                            self.db.remove(&id)?;
                            if self.selected.as_deref() == Some(id.as_str()) {
                                self.selected = None;
                                self.emit(Event::Load {
                                    intent: self.intent,
                                    id: String::new(),
                                    title: String::new(),
                                    html: String::new(),
                                });
                            }
                        }
                    }
                }
                if self.selected.is_none()
                    && let Some(n) = self.db.list(&self.account)?.first()
                {
                    self.show(&n.id)?;
                }
                self.plan_warmup()?;
            }
            Reply::Content { sent, html, etag } => {
                let Ok(mut n) = self.db.get(&sent.id) else {
                    return Ok(());
                };
                if n.deleted {
                    return Ok(());
                }
                if (n.dirty || self.editing.contains(&n.id))
                    && n.html != html
                    && (n.etag.as_deref() != Some(etag.as_str()) || n.conflict)
                {
                    self.conflict(n, html, etag)?;
                } else if !n.dirty {
                    let changed = n.html != html;
                    n.html = html.clone();
                    n.baseline = html;
                    n.etag = Some(etag);
                    n.conflict = false;
                    self.db.put(&n)?;
                    if changed && self.selected.as_deref() == Some(&n.id) {
                        self.emit(Event::Load {
                            intent: self.intent,
                            id: n.id,
                            title: n.title,
                            html: n.html,
                        });
                    } else if changed {
                        self.preload(&n);
                    }
                } else if n.html == html {
                    n.etag = Some(etag);
                    n.baseline = html;
                    n.dirty = false;
                    n.conflict = false;
                    self.db.put(&n)?;
                }
            }
            Reply::Uploaded { sent, item } => {
                self.inflight.remove(&sent.id);
                self.retry.remove(&sent.id);
                self.db
                    .uploaded(&sent, &item.id, &item.etag, &self.account)?;
                self.status = "已同步到 OneDrive".into();
            }
            Reply::Deleted(n) => {
                self.inflight.remove(&n.id);
                self.db.remove(&n.id)?;
                self.status = "已从 OneDrive 删除".into();
            }
            Reply::Conflict { sent, html, etag } => {
                self.inflight.remove(&sent.id);
                let mut n = self.db.get(&sent.id)?;
                if n.remote_id.is_none() {
                    n.remote_id = sent.remote_id;
                }
                self.conflict(n, html, etag)?;
            }
            Reply::Failed { note, message } => {
                if let Some(id) = note {
                    self.inflight.remove(&id);
                    self.retry
                        .insert(id, Instant::now() + Duration::from_secs(120));
                }
                self.status = format!("{message} · 本地草稿已保留");
                self.emit(Event::Error {
                    message: self.status.clone(),
                });
            }
        }
        self.state()
    }
}
fn remote_modified(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|d| d.timestamp_millis())
        .unwrap_or_else(|_| store::now())
}
fn display_title(name: &str) -> String {
    let title = name.strip_suffix(".html").unwrap_or(name);
    if let Some((prefix, suffix)) = title.rsplit_once("--")
        && suffix.len() == 8
        && suffix.chars().all(|c| c.is_ascii_hexdigit())
    {
        prefix.into()
    } else {
        title.into()
    }
}
pub fn start(path: PathBuf) -> Handle {
    let (tx, rx) = mpsc::channel();
    let (event_tx, events) = async_channel::unbounded();
    let (net_tx, net_rx) = mpsc::channel();
    let generation = Arc::new(AtomicU64::new(0));
    cloud::spawn(net_rx, tx.clone(), generation.clone());
    std::thread::Builder::new()
        .name("cnote-storage".into())
        .spawn(move || {
            let db = match Store::open(&path) {
                Ok(s) => s,
                Err(e) => {
                    let _ = event_tx.send_blocking(Event::Error {
                        message: format!("本地数据库无法打开：{e:#}"),
                    });
                    return;
                }
            };
            let account = db.setting("account").ok().flatten().unwrap_or_default();
            let name = db.setting("name").ok().flatten().unwrap_or_default();
            let selected = db
                .setting("selected")
                .ok()
                .flatten()
                .filter(|s| !s.is_empty())
                .filter(|id| {
                    db.get(id)
                        .is_ok_and(|n| !n.deleted && (n.account.is_empty() || n.account == account))
                });
            let mut e = Engine {
                intent: 0,
                editing: HashSet::new(),
                db,
                tx: net_tx,
                events: event_tx,
                generation,
                account,
                name,
                authenticated: false,
                selected,
                status: "离线模式 · 笔记保存在本机".into(),
                inflight: HashSet::new(),
                cloud: HashMap::new(),
                approved: HashMap::new(),
                retry: HashMap::new(),
                asked: HashSet::new(),
                next_sync: Instant::now(),
                warm_queue: VecDeque::new(),
                warmed: HashSet::new(),
                prefetch_queue: VecDeque::new(),
                prefetching: None,
            };
            if !(cfg!(debug_assertions) && std::env::var_os("CNOTE_SMOKE_TEST").is_some()) {
                e.job(Job::Restore);
            }
            e.restore_theme();
            let _ = e.state();
            loop {
                let timeout = if e.warm_queue.is_empty() {
                    Duration::from_secs(1)
                } else {
                    Duration::from_millis(40)
                };
                let result = match rx.recv_timeout(timeout) {
                    Ok(Command::Web(v)) => e.dispatch(v),
                    Ok(Command::SerializedChange(s)) => serde_json::from_str(&s)
                        .context("保存数据无法解析")
                        .and_then(|v| e.dispatch(v)),
                    Ok(Command::Network(epoch, r)) => e.network(epoch, *r),
                    Ok(Command::Prefetched(epoch, r)) => e.prefetched(epoch, *r),
                    Err(mpsc::RecvTimeoutError::Timeout) => e.warm_next(),
                    Err(_) => break,
                };
                if let Err(err) = result {
                    e.emit(Event::Error {
                        message: format!("{err:#}"),
                    });
                }
                if let Err(err) = e.sync() {
                    e.emit(Event::Error {
                        message: format!("{err:#}"),
                    });
                }
                if let Err(err) = e.prefetch_next() {
                    e.emit(Event::Error {
                        message: format!("{err:#}"),
                    });
                }
            }
        })
        .expect("start storage worker");
    Handle { tx, events }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn engine() -> Engine {
        let (tx, _) = mpsc::channel();
        let (events, _) = async_channel::unbounded();
        Engine {
            intent: 0,
            editing: HashSet::new(),
            db: Store::open(std::path::Path::new(":memory:")).unwrap(),
            tx,
            events,
            generation: Arc::new(AtomicU64::new(0)),
            account: "alice".into(),
            name: "Alice".into(),
            authenticated: false,
            selected: None,
            status: String::new(),
            inflight: HashSet::new(),
            cloud: HashMap::new(),
            approved: HashMap::new(),
            retry: HashMap::new(),
            asked: HashSet::new(),
            next_sync: Instant::now(),
            warm_queue: VecDeque::new(),
            warmed: HashSet::new(),
            prefetch_queue: VecDeque::new(),
            prefetching: None,
        }
    }
    #[test]
    fn tool_drafts_are_local_and_acknowledged_after_storage() {
        let mut e = engine();
        let (tx, rx) = async_channel::unbounded();
        e.events = tx;
        let state =
            json!({"text":"private local tool", "left":"old", "right":"new", "rows":[["h"],["v"]]});
        e.dispatch(json!({"type":"tool_save","seq":7,"state":state}))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&e.db.setting("tool_state").unwrap().unwrap()).unwrap(),
            state
        );
        assert!(matches!(
            rx.try_recv().unwrap(),
            Event::ToolSaved { seq: 7 }
        ));
        e.web(json!({"type":"tool_ready"})).unwrap();
        assert!(matches!(rx.try_recv().unwrap(),Event::ToolState{state:s} if s==state));
        assert!(e.db.list("alice").unwrap().is_empty());
    }
    #[test]
    fn invalid_tool_save_keeps_existing_draft_and_reports_failure() {
        let mut e = engine();
        e.db.set_setting("tool_state", "{\"text\":\"kept\"}")
            .unwrap();
        let (tx, rx) = async_channel::unbounded();
        e.events = tx;
        e.dispatch(json!({"type":"tool_save","seq":9,"state":"invalid"}))
            .unwrap();
        assert!(matches!(
            rx.try_recv().unwrap(),
            Event::ToolSaveFailed { seq: 9, .. }
        ));
        assert_eq!(
            e.db.setting("tool_state").unwrap().unwrap(),
            "{\"text\":\"kept\"}"
        );
    }
    #[test]
    fn tool_exports_decode_in_storage_worker_and_reject_path_names() {
        let mut e = engine();
        let (tx, rx) = async_channel::unbounded();
        e.events = tx;
        e.web(json!({"type":"tool_export","filename":"data.csv","data":"YSxi"}))
            .unwrap();
        assert!(
            matches!(rx.try_recv().unwrap(),Event::ToolExport{filename,bytes} if filename=="data.csv"&&bytes==b"a,b")
        );
        assert!(
            e.web(json!({"type":"tool_export","filename":"../data.csv","data":"YSxi"}))
                .is_err()
        );
    }
    #[test]
    fn remote_download_never_overwrites_local_draft() {
        let mut e = engine();
        let mut n = e.db.create("Note", "alice").unwrap();
        n.remote_id = Some("remote".into());
        n.etag = Some("old".into());
        n.dirty = false;
        e.db.put(&n).unwrap();
        e.db.edit(&n.id, "local typing").unwrap();
        e.network(
            0,
            Reply::Content {
                sent: n.clone(),
                html: "remote edit".into(),
                etag: "new".into(),
            },
        )
        .unwrap();
        let after = e.db.get(&n.id).unwrap();
        assert_eq!(after.html, "local typing");
        assert!(after.conflict);
    }
    #[test]
    fn stale_account_response_is_ignored() {
        let mut e = engine();
        e.generation.store(1, Ordering::SeqCst);
        e.network(
            0,
            Reply::Account {
                id: "bob".into(),
                name: "Bob".into(),
            },
        )
        .unwrap();
        assert_eq!(e.account, "alice");
        assert!(!e.authenticated);
    }
    #[test]
    fn edit_acknowledges_only_after_storage() {
        let mut e = engine();
        let n = e.db.create("Note", "alice").unwrap();
        e.web(json!({"type":"change","id":n.id,"seq":9,"html":"<h1>durable</h1>"}))
            .unwrap();
        assert_eq!(e.db.get(&n.id).unwrap().html, "<h1>durable</h1>");
    }
    #[test]
    fn conflict_resolution_uses_latest_local_text() {
        let mut e = engine();
        let n = e.db.create("Note", "alice").unwrap();
        e.conflict(n.clone(), "cloud".into(), "remote-tag".into())
            .unwrap();
        e.db.edit(&n.id, "latest local").unwrap();
        e.web(json!({"type":"resolve","id":n.id,"choice":"mine"}))
            .unwrap();
        let n = e.db.get(&n.id).unwrap();
        assert_eq!(n.html, "latest local");
        assert_eq!(n.etag.as_deref(), Some("remote-tag"));
        assert!(!n.conflict);
        assert!(n.dirty);
    }
    #[test]
    fn merged_conflict_is_saved_against_reviewed_cloud_version() {
        let mut e = engine();
        let (events, receiver) = async_channel::unbounded();
        e.events = events;
        let n = e.db.create("Note", "alice").unwrap();
        e.conflict(n.clone(), "<p>cloud</p>".into(), "tag".into())
            .unwrap();
        e.web(json!({"type":"resolve","id":n.id,"choice":"merge","revision":n.revision,"etag":"tag","html":"<p>merged</p>"})).unwrap();
        let resolved = e.db.get(&n.id).unwrap();
        assert_eq!(resolved.html, "<p>merged</p>");
        assert_eq!(resolved.baseline, "<p>cloud</p>");
        assert_eq!(resolved.etag.as_deref(), Some("tag"));
        assert_eq!(resolved.revision, n.revision + 1);
        assert!(resolved.dirty && !resolved.conflict);
        assert_eq!(e.approved.get(&n.id), Some(&resolved.revision));
        let mut acknowledged = false;
        while let Ok(event) = receiver.try_recv() {
            if let Event::Dialog { kind, data } = event {
                if kind == "conflict_result" {
                    assert_eq!(data["ok"], true);
                    assert_eq!(data["html"], resolved.html);
                    assert_eq!(data["choice"], "merge");
                    assert_eq!(data["pending_sync"], true);
                    acknowledged = true;
                }
            }
        }
        assert!(acknowledged);
    }
    #[test]
    fn stale_conflict_resolution_preserves_both_versions() {
        let mut e = engine();
        let n = e.db.create("Note", "alice").unwrap();
        e.conflict(n.clone(), "cloud".into(), "tag".into()).unwrap();
        e.db.edit(&n.id, "new local").unwrap();
        assert!(e.web(json!({"type":"resolve","id":n.id,"choice":"merge","revision":n.revision,"etag":"tag","html":"stale"})).is_err());
        let current = e.db.get(&n.id).unwrap();
        assert!(e.web(json!({"type":"resolve","id":n.id,"choice":"cloud","revision":current.revision,"etag":"old-tag"})).is_err());
        assert_eq!(e.db.get(&n.id).unwrap().html, "new local");
        assert!(e.db.get(&n.id).unwrap().conflict);
        assert_eq!(e.cloud.get(&n.id).unwrap().0, "cloud");
    }
    #[test]
    fn another_account_cannot_edit_or_delete_note() {
        let mut e = engine();
        let n = e.db.create("Private", "bob").unwrap();
        assert!(
            e.web(json!({"type":"change","id":n.id,"html":"bad"}))
                .is_err()
        );
        assert!(e.web(json!({"type":"delete","id":n.id})).is_err());
        assert!(e.show(&n.id).is_err());
    }
    #[test]
    fn cloud_deletion_keeps_local_draft() {
        let mut e = engine();
        let mut n = e.db.create("Note", "alice").unwrap();
        n.remote_id = Some("removed".into());
        e.db.put(&n).unwrap();
        e.network(0, Reply::List(vec![])).unwrap();
        assert!(e.db.get(&n.id).unwrap().conflict);
    }
    #[test]
    fn cannot_delete_cloud_note_before_version_is_loaded() {
        let mut e = engine();
        let mut n = e.db.create("Loading", "alice").unwrap();
        n.remote_id = Some("remote".into());
        n.etag = None;
        n.dirty = false;
        e.db.put(&n).unwrap();
        assert!(e.web(json!({"type":"delete","id":n.id})).is_err());
        assert!(!e.db.get(&n.id).unwrap().deleted);
    }
    #[test]
    fn delete_conflict_restores_note_to_visible_list() {
        let mut e = engine();
        let mut n = e.db.create("Conflict", "alice").unwrap();
        n.deleted = true;
        e.db.put(&n).unwrap();
        e.conflict(n.clone(), "new cloud".into(), "etag".into())
            .unwrap();
        assert!(!e.db.get(&n.id).unwrap().deleted);
        assert_eq!(e.db.list("alice").unwrap().len(), 1);
    }
    #[test]
    fn cached_navigation_does_not_resend_document_body() {
        let mut e = engine();
        let n = e.db.create("Cached", "alice").unwrap();
        let (tx, rx) = async_channel::unbounded();
        e.events = tx;
        e.web(json!({"type":"open","id":n.id,"intent":7,"cached":true}))
            .unwrap();
        assert_eq!(e.selected.as_deref(), Some(n.id.as_str()));
        assert_eq!(e.intent, 7);
        while let Ok(event) = rx.try_recv() {
            assert!(!matches!(event, Event::Load { .. }));
        }
    }
    #[test]
    fn save_ack_does_not_rebuild_the_entire_sidebar() {
        let mut e = engine();
        let n = e.db.create("Save", "alice").unwrap();
        let (tx, rx) = async_channel::unbounded();
        e.events = tx;
        e.dispatch(json!({"type":"change","id":n.id,"html":"<p>Changed</p>","seq":4}))
            .unwrap();
        assert!(matches!(
            rx.try_recv().unwrap(),
            Event::Saved { seq: 4, .. }
        ));
        assert!(rx.try_recv().is_err());
        assert_eq!(e.db.get(&n.id).unwrap().html, "<p>Changed</p>");
    }
    #[test]
    fn saving_a_heading_sends_a_small_title_update() {
        let mut e = engine();
        let n = e.db.create("OpenClaw", "alice").unwrap();
        let (tx, rx) = async_channel::unbounded();
        e.events = tx;
        e.dispatch(json!({"type":"change","id":n.id,"html":"<h2>AI各种琢磨</h2>","seq":1}))
            .unwrap();
        assert!(
            matches!(rx.try_recv().unwrap(), Event::Saved { title, .. } if title == "AI各种琢磨")
        );
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn theme_selection_is_saved_and_restored_independently_of_notes() {
        let mut e = engine();
        let (tx, rx) = async_channel::unbounded();
        e.events = tx;
        e.restore_theme();
        assert!(matches!(
            rx.try_recv().unwrap(),
            Event::Theme {
                theme: Theme::System
            }
        ));
        for theme in Theme::ALL {
            e.dispatch(json!({"type":"theme","value":theme.as_str()}))
                .unwrap();
            assert!(
                matches!(rx.try_recv().unwrap(), Event::Theme { theme: saved } if saved == theme)
            );
            assert_eq!(
                e.db.setting("theme").unwrap().as_deref(),
                Some(theme.as_str())
            );
            e.restore_theme();
            assert!(
                matches!(rx.try_recv().unwrap(), Event::Theme { theme: saved } if saved == theme)
            );
        }
        assert!(e.db.list("alice").unwrap().is_empty());
        e.db.set_setting("theme", "invalid").unwrap();
        e.restore_theme();
        assert!(matches!(
            rx.try_recv().unwrap(),
            Event::Theme {
                theme: Theme::System
            }
        ));
    }
    #[test]
    fn save_errors_identify_the_draft_for_background_retry() {
        let mut e = engine();
        let n = e.db.create("Private", "bob").unwrap();
        let (tx, rx) = async_channel::unbounded();
        e.events = tx;
        e.dispatch(json!({"type":"change","id":n.id,"html":"foreign edit","seq":5}))
            .unwrap();
        assert!(matches!(rx.try_recv().unwrap(),Event::SaveFailed{id,seq:5,..} if id==n.id));
        assert_ne!(e.db.get(&n.id).unwrap().html, "foreign edit");
    }
    #[test]
    fn unpersisted_typing_is_protected_from_remote_updates() {
        let mut e = engine();
        let mut n = e.db.create("Typing", "alice").unwrap();
        n.remote_id = Some("remote".into());
        n.etag = Some("old".into());
        n.dirty = false;
        e.db.put(&n).unwrap();
        e.web(json!({"type":"editing","id":n.id})).unwrap();
        e.network(
            0,
            Reply::Content {
                sent: n.clone(),
                html: "remote change".into(),
                etag: "new".into(),
            },
        )
        .unwrap();
        assert!(e.db.get(&n.id).unwrap().conflict);
        e.web(json!({"type":"change","id":n.id,"html":"latest typing","seq":1}))
            .unwrap();
        assert_eq!(e.db.get(&n.id).unwrap().html, "latest typing");
        assert!(e.db.get(&n.id).unwrap().conflict);
    }
}
