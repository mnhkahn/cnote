//! Browser note model. IO and clock/IDs are supplied by the browser adapter.
//! Keep desktop-only crates out of this target.
#[path = "../../../src/note_title.rs"]
mod note_title;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

#[derive(Clone, Default, Serialize, Deserialize)]
struct Note {
    id: String,
    account: String,
    title: String,
    html: String,
    #[serde(default)]
    remote_id: String,
    #[serde(default)]
    etag: String,
    #[serde(default)]
    baseline: String,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    dirty: bool,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    modified: u64,
    #[serde(default)]
    conflict: Option<Remote>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Remote {
    html: String,
    etag: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct State {
    version: u32,
    account: String,
    selected: String,
    notes: Vec<Note>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            account: String::new(),
            selected: String::new(),
            notes: Vec::new(),
        }
    }
}
#[wasm_bindgen]
pub struct Notebook {
    state: State,
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key].as_str().ok_or_else(|| format!("缺少字段 {key}"))
}
fn checked_html(value: &Value) -> Result<String, String> {
    let html = string(value, "html")?;
    if html.len() > 20 * 1024 * 1024 {
        return Err("笔记超过 20 MB".into());
    }
    Ok(html.into())
}
#[wasm_bindgen]
impl Notebook {
    #[wasm_bindgen(constructor)]
    pub fn new(snapshot: &str) -> Result<Notebook, String> {
        let state: State = if snapshot.is_empty() {
            State::default()
        } else {
            serde_json::from_str(snapshot).map_err(|_| "本地笔记数据损坏，未覆盖原数据")?
        };
        if state.version != 1 {
            return Err("不支持的笔记数据版本，未覆盖原数据".into());
        }
        Ok(Self { state })
    }
    pub fn snapshot(&self) -> String {
        serde_json::to_string(&self.state).expect("serializable notes")
    }
    pub fn view(&self) -> String {
        let notes: Vec<_> = self.state.notes.iter().filter(|n| n.account == self.state.account && !n.deleted).map(|n| {
            let heading = note_title::heading(&n.html);
            json!({"id": n.id, "title": if heading.is_empty() { &n.title } else { &heading }, "dirty": n.dirty, "conflict": n.conflict.is_some(), "modified": n.modified})
        }).collect();
        json!({"account": self.state.account, "selected": self.state.selected, "notes": notes})
            .to_string()
    }
    /// Mutations are transactional even for malformed or stale commands.
    pub fn execute(&mut self, command: &str) -> Result<String, String> {
        let v: Value = serde_json::from_str(command).map_err(|_| "命令格式错误")?;
        let backup = self.state.clone();
        match self.apply(&v) {
            Ok(result) => Ok(result.to_string()),
            Err(error) => {
                self.state = backup;
                Err(error)
            }
        }
    }
}
impl Notebook {
    fn apply(&mut self, v: &Value) -> Result<Value, String> {
        let kind = string(v, "type")?;
        if kind == "account" {
            let account = string(v, "account")?.to_owned();
            if !account.is_empty() {
                for n in &mut self.state.notes {
                    if n.account.is_empty() {
                        n.account = account.clone();
                    }
                }
            }
            self.state.account = account;
            self.state.selected.clear();
            return Ok(json!({}));
        }
        if kind == "new" || kind == "import" {
            let id = string(v, "id")?;
            if id.is_empty() || self.state.notes.iter().any(|n| n.id == id) {
                return Err("笔记 ID 重复或为空".into());
            }
            let title = string(v, "title")?.trim();
            if title.is_empty() || title.chars().count() > 200 {
                return Err("笔记标题长度无效".into());
            }
            let html = checked_html(v)?;
            let remote_id = v["remote_id"].as_str().unwrap_or("").to_owned();
            if !remote_id.is_empty()
                && self
                    .state
                    .notes
                    .iter()
                    .any(|n| n.account == self.state.account && n.remote_id == remote_id)
            {
                return Err("云端笔记已存在".into());
            }
            self.state.notes.push(Note {
                id: id.into(),
                account: self.state.account.clone(),
                title: title.into(),
                html,
                remote_id,
                etag: v["etag"].as_str().unwrap_or("").into(),
                dirty: kind == "new",
                modified: v["now"].as_u64().unwrap_or(0),
                ..Default::default()
            });
            if kind == "new" {
                self.state.selected = id.into();
            }
            return Ok(json!({}));
        }
        let id = string(v, "id")?;
        let note = self
            .state
            .notes
            .iter_mut()
            .find(|n| n.id == id && n.account == self.state.account)
            .ok_or("笔记不存在或属于其他账号")?;
        match kind {
            "open" => {
                self.state.selected = id.into();
                return Ok(json!({"type":"load","id":note.id,"title":note.title,"html":note.html}));
            }
            "change" => {
                if note.deleted {
                    return Err("笔记已删除".into());
                }
                let html = checked_html(v)?;
                if note.html != html {
                    note.html = html;
                    note.revision += 1;
                    note.dirty = true;
                    note.modified = v["now"].as_u64().unwrap_or(0);
                }
            }
            "delete" => {
                note.deleted = true;
                note.dirty = true;
                note.revision += 1;
                self.state.selected.clear();
            }
            "uploaded" => {
                note.remote_id = string(v, "remote_id")?.into();
                note.etag = string(v, "etag")?.into();
                note.baseline = checked_html(v)?;
                if v["revision"].as_u64() == Some(note.revision) {
                    note.dirty = false;
                }
            }
            "remote" => {
                let html = checked_html(v)?;
                let etag = string(v, "etag")?.to_owned();
                if note.dirty && (note.deleted || html != note.html) {
                    note.deleted = false;
                    note.conflict = Some(Remote { html, etag });
                } else {
                    note.html = html.clone();
                    note.baseline = html;
                    note.etag = etag;
                    note.dirty = false;
                }
            }
            "conflict_view" => {
                let remote = note.conflict.as_ref().ok_or("没有待处理冲突")?;
                return Ok(
                    json!({"type":"dialog","kind":"conflict_view","data":{"id":id,"title":note.title,"local":note.html,"cloud":remote.html,"etag":remote.etag,"revision":note.revision}}),
                );
            }
            "resolve" => {
                let remote = note.conflict.clone().ok_or("没有待处理冲突")?;
                if v["revision"].as_u64() != Some(note.revision)
                    || string(v, "etag")? != remote.etag
                {
                    return Err("笔记或云端版本已变化，请重新对比".into());
                }
                let choice = string(v, "choice")?;
                let html = match choice {
                    "cloud" => remote.html.clone(),
                    "mine" => note.html.clone(),
                    "merge" => checked_html(v)?,
                    _ => return Err("无效冲突选择".into()),
                };
                note.html = html;
                note.etag = remote.etag;
                note.baseline = remote.html;
                note.conflict = None;
                note.revision += 1;
                note.dirty = choice != "cloud";
                return Ok(
                    json!({"type":"dialog","kind":"conflict_result","data":{"id":id,"ok":true,"html":note.html,"pending_sync":note.dirty}}),
                );
            }
            "remote_removed" => {
                if !note.dirty && v["revision"].as_u64() == Some(note.revision) {
                    self.state.notes.retain(|n| n.id != id);
                    if self.state.selected == id {
                        self.state.selected.clear();
                    }
                }
            }
            "removed" => {
                if v["revision"].as_u64() != Some(note.revision) || !note.deleted {
                    return Err("删除期间笔记已变化".into());
                }
                self.state.notes.retain(|n| n.id != id);
            }
            _ => return Err("未知笔记命令".into()),
        }
        Ok(json!({}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn run(n: &mut Notebook, v: Value) -> Value {
        serde_json::from_str(&n.execute(&v.to_string()).unwrap()).unwrap()
    }
    fn note() -> Notebook {
        let mut n = Notebook::new("").unwrap();
        run(
            &mut n,
            json!({"type":"new","id":"a","title":"Note","html":"<h1>标题</h1>"}),
        );
        n
    }
    #[test]
    fn restores_local_drafts_and_titles() {
        let n = note();
        let restored = Notebook::new(&n.snapshot()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&restored.view()).unwrap()["notes"][0]["title"],
            "标题"
        );
        assert!(Notebook::new("{bad").is_err());
        assert!(Notebook::new(r#"{"version":2,"account":"","selected":"","notes":[]}"#).is_err());
    }
    #[test]
    fn upload_ack_keeps_newer_edits_and_accounts_are_isolated() {
        let mut n = note();
        run(&mut n, json!({"type":"account","account":"first"}));
        run(&mut n, json!({"type":"change","id":"a","html":"new draft"}));
        run(
            &mut n,
            json!({"type":"uploaded","id":"a","revision":0,"html":"old","remote_id":"remote","etag":"v1"}),
        );
        assert!(n.state.notes[0].dirty);
        assert_eq!(n.state.notes[0].html, "new draft");
        run(&mut n, json!({"type":"account","account":"second"}));
        let before = n.snapshot();
        assert!(
            n.execute(r#"{"type":"change","id":"a","html":"bad"}"#)
                .is_err()
        );
        assert_eq!(before, n.snapshot());
    }
    #[test]
    fn remote_removal_cannot_discard_local_edits() {
        let mut n = note();
        run(
            &mut n,
            json!({"type":"uploaded","id":"a","revision":0,"html":"old","remote_id":"r","etag":"v1"}),
        );
        run(
            &mut n,
            json!({"type":"change","id":"a","html":"new local draft"}),
        );
        run(
            &mut n,
            json!({"type":"remote_removed","id":"a","revision":0}),
        );
        assert_eq!(n.state.notes[0].html, "new local draft");
        run(&mut n, json!({"type":"delete","id":"a"}));
        run(
            &mut n,
            json!({"type":"remote","id":"a","html":"cloud changed","etag":"v2"}),
        );
        assert!(!n.state.notes[0].deleted);
        assert!(n.state.notes[0].conflict.is_some());
    }
    #[test]
    fn stale_conflict_resolution_preserves_both_versions() {
        let mut n = note();
        run(
            &mut n,
            json!({"type":"remote","id":"a","html":"cloud","etag":"v2"}),
        );
        run(&mut n, json!({"type":"change","id":"a","html":"new draft"}));
        let before = n.snapshot();
        assert!(
            n.execute(r#"{"type":"resolve","id":"a","choice":"cloud","revision":0,"etag":"v2"}"#)
                .is_err()
        );
        assert_eq!(before, n.snapshot());
        run(
            &mut n,
            json!({"type":"resolve","id":"a","choice":"merge","revision":1,"etag":"v2","html":"merged"}),
        );
        assert_eq!(n.state.notes[0].html, "merged");
        assert!(n.state.notes[0].dirty);
        assert!(n.state.notes[0].conflict.is_none());
    }
}
