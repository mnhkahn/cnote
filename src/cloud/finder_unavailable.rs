//! Shared consumers have no Finder mount. Lifecycle hooks are intentionally empty.
pub fn disconnect() -> anyhow::Result<()> {
    Ok(())
}
pub fn account_changed(_: &str) {}
