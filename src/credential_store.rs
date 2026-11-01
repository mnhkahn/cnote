//! One Keychain item for CNote credentials, shared by OneDrive and Trello.
//! Old items are read only when their account has not yet been migrated.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    sync::{Mutex, OnceLock},
};

const SERVICE: &str = "com.cyeam.cnote";
const VAULT: &str = "credentials-v1";
static STORE: OnceLock<Mutex<Store<Keychain>>> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
struct Document {
    version: u8,
    // None is a persisted logout marker: never resurrect an old account item.
    entries: BTreeMap<String, Option<String>>,
}
impl Default for Document {
    fn default() -> Self {
        Self {
            version: 1,
            entries: BTreeMap::new(),
        }
    }
}
trait Backend {
    fn read(&self, account: &str) -> Result<Option<String>>;
    fn write(&self, account: &str, value: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}
struct Keychain;
impl Backend for Keychain {
    fn read(&self, account: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new(SERVICE, account).context("无法访问 CNote 系统钥匙串")?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => anyhow::bail!("无法读取 CNote 系统钥匙串，请检查钥匙串访问权限"),
        }
    }
    fn write(&self, account: &str, value: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, account)
            .context("无法访问 CNote 系统钥匙串")?
            .set_password(value)
            .map_err(|_| anyhow::anyhow!("无法保存 CNote 系统钥匙串凭据"))
    }
    fn delete(&self, account: &str) -> Result<()> {
        match keyring::Entry::new(SERVICE, account)
            .context("无法访问 CNote 系统钥匙串")?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => anyhow::bail!("无法移除旧的 CNote 系统钥匙串凭据"),
        }
    }
}
struct Store<B> {
    backend: B,
    cached: Option<Document>,
}
impl<B: Backend> Store<B> {
    fn load(&self) -> Result<Document> {
        let Some(value) = self.backend.read(VAULT)? else {
            return Ok(Document::default());
        };
        let document: Document = serde_json::from_str(&value)
            .map_err(|_| anyhow::anyhow!("CNote 钥匙串数据格式错误，未覆盖原记录"))?;
        anyhow::ensure!(
            document.version == 1,
            "CNote 钥匙串版本不受支持，未覆盖原记录"
        );
        Ok(document)
    }
    fn persist(&mut self, document: Document) -> Result<()> {
        let value = serde_json::to_string(&document).context("无法编码 CNote 凭据")?;
        self.backend.write(VAULT, &value)?;
        // A failed write must not be acknowledged or replace the usable cache.
        self.cached = Some(document);
        Ok(())
    }
    fn get(&mut self, account: &str) -> Result<Option<String>> {
        if let Some(value) = self
            .cached
            .as_ref()
            .and_then(|doc| doc.entries.get(account))
        {
            return Ok(value.clone());
        }
        let mut document = self.load()?;
        if let Some(value) = document.entries.get(account) {
            let result = value.clone();
            self.cached = Some(document);
            return Ok(result);
        }
        let value = self.backend.read(account)?;
        document.entries.insert(account.into(), value.clone());
        if value.is_some() {
            self.persist(document)?;
        } else {
            self.cached = Some(document);
        }
        // Keep old records intact during migration. An explicit logout removes them.
        Ok(value)
    }
    fn set(&mut self, account: &str, value: &str) -> Result<()> {
        // Reload under the cross-process lock before merging so a write by the
        // installed app cannot clobber another account saved by a developer build.
        let mut document = self.load()?;
        document.entries.insert(account.into(), Some(value.into()));
        self.persist(document)
    }
    fn remove(&mut self, account: &str) -> Result<()> {
        let mut document = self.load()?;
        self.backend.delete(account)?;
        document.entries.insert(account.into(), None);
        self.persist(document)
    }
}
fn with_store<T>(
    account: &str,
    operation: impl FnOnce(&mut Store<Keychain>) -> Result<T>,
) -> Result<T> {
    anyhow::ensure!(
        matches!(account, "onedrive-oauth" | "trello-auth"),
        "未知的 CNote 凭据类型"
    );
    let mut store = STORE
        .get_or_init(|| {
            Mutex::new(Store {
                backend: Keychain,
                cached: None,
            })
        })
        .lock()
        .map_err(|_| anyhow::anyhow!("CNote 凭据状态异常，请重启应用"))?;
    // Only a lock file is stored here, never credentials. All running copies of
    // CNote use the same lock even when CNOTE_DATA_DIR differs.
    let directories =
        directories::ProjectDirs::from("com", "cyeam", "CNote").context("找不到 CNote 数据目录")?;
    std::fs::create_dir_all(directories.data_dir()).context("无法创建 CNote 凭据锁目录")?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(directories.data_dir().join("credentials.lock"))
        .context("无法打开 CNote 凭据锁")?;
    file.lock().context("无法锁定 CNote 凭据存储")?;
    operation(&mut store)
    // File close releases the lock on success and on every error path.
}
pub fn get(account: &str) -> Result<Option<String>> {
    with_store(account, |store| store.get(account))
}
pub fn set(account: &str, value: &str) -> Result<()> {
    with_store(account, |store| store.set(account, value))
}
pub fn remove(account: &str) -> Result<()> {
    with_store(account, |store| store.remove(account))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    #[derive(Default)]
    struct Memory {
        values: RefCell<BTreeMap<String, String>>,
        reads: RefCell<Vec<String>>,
        fail_write: Cell<bool>,
        fail_read: Cell<bool>,
    }
    impl Backend for Memory {
        fn read(&self, key: &str) -> Result<Option<String>> {
            if self.fail_read.get() {
                anyhow::bail!("denied");
            }
            self.reads.borrow_mut().push(key.into());
            Ok(self.values.borrow().get(key).cloned())
        }
        fn write(&self, key: &str, value: &str) -> Result<()> {
            if self.fail_write.get() {
                anyhow::bail!("save failed");
            }
            self.values.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<()> {
            self.values.borrow_mut().remove(key);
            Ok(())
        }
    }
    fn store() -> Store<Memory> {
        Store {
            backend: Memory::default(),
            cached: None,
        }
    }
    #[test]
    fn both_accounts_restore_from_one_item_after_migration_and_restart() {
        let mut store = store();
        store.backend.values.borrow_mut().extend([
            ("onedrive-oauth".into(), "one".into()),
            ("trello-auth".into(), "two".into()),
        ]);
        assert_eq!(store.get("onedrive-oauth").unwrap().as_deref(), Some("one"));
        assert_eq!(store.get("trello-auth").unwrap().as_deref(), Some("two"));
        store.cached = None;
        store.backend.reads.borrow_mut().clear();
        assert_eq!(store.get("onedrive-oauth").unwrap().as_deref(), Some("one"));
        assert_eq!(store.get("trello-auth").unwrap().as_deref(), Some("two"));
        assert_eq!(*store.backend.reads.borrow(), vec![VAULT]);
    }
    #[test]
    fn logout_does_not_remove_another_account_or_revive_a_legacy_token() {
        let mut store = store();
        store.set("onedrive-oauth", "one").unwrap();
        store.set("trello-auth", "two").unwrap();
        store.remove("trello-auth").unwrap();
        store
            .backend
            .values
            .borrow_mut()
            .insert("trello-auth".into(), "old".into());
        store.cached = None;
        assert!(store.get("trello-auth").unwrap().is_none());
        assert_eq!(store.get("onedrive-oauth").unwrap().as_deref(), Some("one"));
    }
    #[test]
    fn failed_migration_keeps_legacy_data_and_can_retry() {
        let mut store = store();
        store
            .backend
            .values
            .borrow_mut()
            .insert("trello-auth".into(), "old".into());
        store.backend.fail_write.set(true);
        assert!(store.get("trello-auth").is_err());
        assert!(store.cached.is_none());
        assert_eq!(
            store
                .backend
                .values
                .borrow()
                .get("trello-auth")
                .map(String::as_str),
            Some("old")
        );
        store.backend.fail_write.set(false);
        assert_eq!(store.get("trello-auth").unwrap().as_deref(), Some("old"));
    }
    #[test]
    fn unavailable_keychain_and_foreign_writes_do_not_get_overwritten() {
        let mut store = store();
        store.backend.fail_read.set(true);
        assert!(store.get("trello-auth").is_err());
        assert!(store.cached.is_none());
        store.backend.fail_read.set(false);
        store.set("trello-auth", "two").unwrap();
        let mut document: Document =
            serde_json::from_str(store.backend.values.borrow().get(VAULT).unwrap()).unwrap();
        document
            .entries
            .insert("onedrive-oauth".into(), Some("external".into()));
        store
            .backend
            .values
            .borrow_mut()
            .insert(VAULT.into(), serde_json::to_string(&document).unwrap());
        store.set("trello-auth", "new").unwrap();
        assert_eq!(
            store.get("onedrive-oauth").unwrap().as_deref(),
            Some("external")
        );
    }
}
