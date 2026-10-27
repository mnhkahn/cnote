//! SQLite is owned by the storage actor; the UI never does disk or network IO.
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub account: String,
    pub remote_id: Option<String>,
    pub title: String,
    pub html: String,
    pub baseline: String,
    pub etag: Option<String>,
    pub revision: i64,
    pub dirty: bool,
    pub deleted: bool,
    pub conflict: bool,
    pub modified: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub dirty: bool,
    pub conflict: bool,
    pub modified: i64,
}
pub struct Store(Connection);
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY, account TEXT NOT NULL DEFAULT '', remote_id TEXT,
                title TEXT NOT NULL, html TEXT NOT NULL DEFAULT '', baseline TEXT NOT NULL DEFAULT '',
                etag TEXT, revision INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1,
                deleted INTEGER NOT NULL DEFAULT 0, conflict INTEGER NOT NULL DEFAULT 0,
                modified INTEGER NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS remote_note ON notes(account,remote_id);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
        // Keep derived labels separate from the note's file metadata.
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS note_titles (
            note_id TEXT PRIMARY KEY, display_title TEXT NOT NULL,
            revision INTEGER NOT NULL, etag TEXT);",
        )?;
        let transaction = db.unchecked_transaction()?;
        {
            let mut notes = transaction.prepare(
                "SELECT n.id,n.html,n.revision,n.etag FROM notes n
                LEFT JOIN note_titles t ON t.note_id=n.id
                WHERE t.note_id IS NULL OR t.revision<>n.revision OR t.etag IS NOT n.etag",
            )?;
            let mut update =
                transaction.prepare("INSERT OR REPLACE INTO note_titles VALUES (?,?,?,?)")?;
            for note in notes.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })? {
                let (id, html, revision, etag) = note?;
                update.execute(params![
                    id,
                    crate::note_title::heading(&html),
                    revision,
                    etag
                ])?;
            }
        }
        transaction.commit()?;
        Ok(Self(db))
    }
    pub fn get(&self, id: &str) -> Result<Note> {
        self.0.query_row("SELECT id,account,remote_id,title,html,baseline,etag,revision,dirty,deleted,conflict,modified FROM notes WHERE id=?", [id], |r| Ok(Note {
            id:r.get(0)?, account:r.get(1)?, remote_id:r.get(2)?, title:r.get(3)?, html:r.get(4)?, baseline:r.get(5)?, etag:r.get(6)?, revision:r.get(7)?, dirty:r.get(8)?, deleted:r.get(9)?, conflict:r.get(10)?, modified:r.get(11)?
        })).with_context(|| format!("找不到笔记 {id}"))
    }
    pub fn put(&self, n: &Note) -> Result<()> {
        let transaction = self.0.unchecked_transaction()?;
        transaction.execute("INSERT INTO notes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
            ON CONFLICT(id) DO UPDATE SET account=excluded.account,remote_id=excluded.remote_id,title=excluded.title,html=excluded.html,baseline=excluded.baseline,etag=excluded.etag,revision=excluded.revision,dirty=excluded.dirty,deleted=excluded.deleted,conflict=excluded.conflict,modified=excluded.modified",
            params![n.id,n.account,n.remote_id,n.title,n.html,n.baseline,n.etag,n.revision,n.dirty,n.deleted,n.conflict,n.modified])?;
        transaction.execute(
            "INSERT OR REPLACE INTO note_titles VALUES (?,?,?,?)",
            params![
                n.id,
                crate::note_title::heading(&n.html),
                n.revision,
                n.etag
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }
    pub fn create(&self, title: &str, account: &str) -> Result<Note> {
        let title = title.trim().trim_end_matches(".html");
        if title.is_empty()
            || title
                .chars()
                .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
            || title.len() > 160
        {
            bail!("请输入有效标题（不能包含路径或特殊文件名字符，最多 160 字节）");
        }
        // The ID suffix makes retries idempotent without overwriting an existing cloud file.
        let n = Note {
            id: uuid::Uuid::new_v4().to_string(),
            account: account.into(),
            remote_id: None,
            title: title.into(),
            html: "<p><br></p>".into(),
            baseline: String::new(),
            etag: None,
            revision: 0,
            dirty: true,
            deleted: false,
            conflict: false,
            modified: now(),
        };
        self.put(&n)?;
        Ok(n)
    }
    /// Save without reading/copying the full body or its cloud baseline first.
    pub fn save_html(&self, id: &str, account: &str, html: &str) -> Result<()> {
        if html.len() > 20 * 1024 * 1024 {
            bail!("笔记超过 20 MB，请缩小粘贴图片后再试");
        }
        let transaction = self.0.unchecked_transaction()?;
        let updated = transaction.execute(
            "UPDATE notes SET
            revision=revision+CASE WHEN html<>?1 THEN 1 ELSE 0 END,
            dirty=CASE WHEN html<>?1 THEN 1 ELSE dirty END,
            modified=CASE WHEN html<>?1 THEN ?2 ELSE modified END,
            html=?1 WHERE id=?3 AND deleted=0 AND (account='' OR account=?4)",
            params![html, now(), id, account],
        )?;
        if updated == 0 {
            bail!("笔记已删除、账号已切换或笔记不存在；草稿仍保留在内存中");
        }
        transaction.execute(
            "INSERT OR REPLACE INTO note_titles SELECT id,?1,revision,etag FROM notes WHERE id=?2",
            params![crate::note_title::heading(html), id],
        )?;
        transaction.commit()?;
        Ok(())
    }
    pub fn display_title(&self, id: &str) -> Result<String> {
        Ok(self.0.query_row(
            "SELECT COALESCE(NULLIF(t.display_title,''),n.title) FROM notes n LEFT JOIN note_titles t ON t.note_id=n.id AND t.revision=n.revision AND t.etag IS n.etag WHERE n.id=?",
            [id],
            |row| row.get(0),
        )?)
    }
    #[cfg(test)]
    pub fn edit(&self, id: &str, html: &str) -> Result<Note> {
        let n = self.get(id)?;
        self.save_html(id, &n.account, html)?;
        self.get(id)
    }
    pub fn list(&self, account: &str) -> Result<Vec<Summary>> {
        let mut s=self.0.prepare("SELECT n.id,COALESCE(NULLIF(t.display_title,''),n.title),n.dirty,n.conflict,n.modified FROM notes n LEFT JOIN note_titles t ON t.note_id=n.id AND t.revision=n.revision AND t.etag IS n.etag WHERE n.deleted=0 AND (n.account='' OR n.account=?1) ORDER BY n.modified DESC,n.id")?;
        Ok(s.query_map([account], |r| {
            Ok(Summary {
                id: r.get(0)?,
                title: r.get(1)?,
                dirty: r.get(2)?,
                conflict: r.get(3)?,
                modified: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
    }
    pub fn first_cached_id(&self, account: &str) -> Result<Option<String>> {
        Ok(self.0.query_row(
            "SELECT id FROM notes WHERE deleted=0 AND (account='' OR account=?1) AND (remote_id IS NULL OR etag IS NOT NULL OR dirty=1) ORDER BY modified DESC,id LIMIT 1",
            [account], |row| row.get(0),
        ).optional()?)
    }
    pub fn pending(&self, account: &str) -> Result<Vec<Note>> {
        let mut s = self.0.prepare(
            "SELECT id FROM notes WHERE dirty=1 AND conflict=0 AND (account='' OR account=?1)",
        )?;
        let ids = s
            .query_map([account], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter().map(|id| self.get(id)).collect()
    }
    /// Listing cloud metadata must not copy or rewrite cached document bodies.
    pub fn update_remote_metadata(
        &self,
        account: &str,
        remote: &str,
        title: &str,
        modified: i64,
    ) -> Result<Option<(String, Option<String>, bool)>> {
        let cached = self
            .0
            .query_row(
                "SELECT id,etag,dirty FROM notes WHERE account=?1 AND remote_id=?2",
                params![account, remote],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((id, _, _)) = &cached {
            self.0.execute(
                "UPDATE notes SET title=?1,modified=CASE WHEN dirty=0 THEN ?2 ELSE modified END WHERE id=?3",
                params![title, modified, id],
            )?;
        }
        Ok(cached)
    }
    pub fn remote_entries(&self, account: &str) -> Result<Vec<(String, String, bool)>> {
        let mut query = self.0.prepare(
            "SELECT id,remote_id,dirty FROM notes WHERE deleted=0 AND account=?1 AND remote_id IS NOT NULL",
        )?;
        Ok(query
            .query_map([account], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn mark_conflict(&self, id: &str) -> Result<()> {
        self.0
            .execute("UPDATE notes SET conflict=1 WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .0
            .query_row("SELECT value FROM settings WHERE key=?", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.0.execute("INSERT INTO settings VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
        Ok(())
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        self.0.execute("DELETE FROM notes WHERE id=?", [id])?;
        Ok(())
    }
    /// An upload completion only acknowledges the captured revision, never subsequent edits.
    pub fn uploaded(&self, sent: &Note, remote: &str, etag: &str, account: &str) -> Result<Note> {
        let mut n = self.get(&sent.id)?;
        n.account = account.into();
        n.remote_id = Some(remote.into());
        n.etag = Some(etag.into());
        n.baseline = sent.html.clone();
        n.dirty = n.revision != sent.revision || n.deleted;
        self.put(&n)?;
        Ok(n)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Store {
        Store::open(Path::new(":memory:")).unwrap()
    }
    #[test]
    fn sidebar_titles_follow_body_headings_without_renaming_files() {
        let s = db();
        let mut n = s.create("OpenClaw", "alice").unwrap();
        assert_eq!(s.list("alice").unwrap()[0].title, "OpenClaw");
        s.save_html(&n.id, "alice", "<h2>AI各种琢磨</h2><p>正文</p>")
            .unwrap();
        assert_eq!(s.list("alice").unwrap()[0].title, "AI各种琢磨");
        assert_eq!(s.display_title(&n.id).unwrap(), "AI各种琢磨");
        assert_eq!(s.get(&n.id).unwrap().title, "OpenClaw");
        n.html = "<h1>云端的新标题</h1>".into();
        s.put(&n).unwrap();
        assert_eq!(s.list("alice").unwrap()[0].title, "云端的新标题");
        s.save_html(&n.id, "alice", "<p>删去标题后的正文</p>")
            .unwrap();
        assert_eq!(s.display_title(&n.id).unwrap(), "OpenClaw");
    }
    #[test]
    fn legacy_notes_get_body_titles_on_first_open() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.db");
        let id = {
            let s = Store::open(&path).unwrap();
            let n = s.create("OpenClaw", "alice").unwrap();
            s.edit(&n.id, "<h2>AI各种琢磨</h2>").unwrap();
            s.0.execute("DROP TABLE note_titles", []).unwrap();
            n.id
        };
        for _ in 0..2 {
            let s = Store::open(&path).unwrap();
            assert_eq!(s.list("alice").unwrap()[0].title, "AI各种琢磨");
            let n = s.get(&id).unwrap();
            assert_eq!(n.title, "OpenClaw");
            assert_eq!(n.revision, 1);
            assert!(s.list("bob").unwrap().is_empty());
        }
    }
    #[test]
    fn upload_does_not_clear_newer_edits() {
        let s = db();
        let n = s.create("测试", "").unwrap();
        let sent = s.edit(&n.id, "first").unwrap();
        s.edit(&n.id, "newer").unwrap();
        let got = s.uploaded(&sent, "remote", "tag", "alice").unwrap();
        assert!(got.dirty);
        assert_eq!(got.html, "newer");
        assert_eq!(got.baseline, "first");
    }
    #[test]
    fn accounts_are_isolated() {
        let s = db();
        s.create("Alice", "alice").unwrap();
        s.create("Bob", "bob").unwrap();
        s.create("Local", "").unwrap();
        assert_eq!(s.list("alice").unwrap().len(), 2);
        assert_eq!(s.list("").unwrap().len(), 1);
        assert_eq!(s.list("bob").unwrap().len(), 2);
    }
    #[test]
    fn drafts_survive_reopen() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("test.db");
        let id = {
            let s = Store::open(&p).unwrap();
            let n = s.create("恢复", "").unwrap();
            s.edit(&n.id, "<h1>草稿 ✓</h1>").unwrap();
            n.id
        };
        let s = Store::open(&p).unwrap();
        assert_eq!(s.get(&id).unwrap().html, "<h1>草稿 ✓</h1>");
    }
    #[test]
    fn deleted_upload_stays_pending() {
        let s = db();
        let sent = s.create("test", "").unwrap();
        let mut n = sent.clone();
        n.deleted = true;
        s.put(&n).unwrap();
        assert!(s.uploaded(&sent, "id", "tag", "a").unwrap().dirty);
    }
    #[test]
    fn reject_path_names() {
        assert!(db().create("../escape", "").is_err());
    }
}
