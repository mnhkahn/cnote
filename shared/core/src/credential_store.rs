//! The host supplies secure storage. Never fall back to plaintext credentials.
use anyhow::{Result, anyhow};
use std::sync::{Arc, OnceLock};
pub trait Vault: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, value: Option<&str>) -> Result<()>;
}
static VAULT: OnceLock<Arc<dyn Vault>> = OnceLock::new();
pub fn install(vault: Arc<dyn Vault>) -> Result<()> {
    VAULT.set(vault).map_err(|_| anyhow!("凭据存储已初始化"))
}
pub fn get(key: &str) -> Result<Option<String>> {
    VAULT
        .get()
        .ok_or_else(|| anyhow!("凭据存储未初始化"))?
        .get(key)
}
pub fn set(key: &str, value: &str) -> Result<()> {
    VAULT
        .get()
        .ok_or_else(|| anyhow!("凭据存储未初始化"))?
        .set(key, Some(value))
}
pub fn remove(key: &str) -> Result<()> {
    VAULT
        .get()
        .ok_or_else(|| anyhow!("凭据存储未初始化"))?
        .set(key, None)
}
