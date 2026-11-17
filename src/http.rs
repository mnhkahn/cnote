//! HTTP defaults with an optional host-supplied client factory for shared consumers.
#[cfg(cnote_shared_core)]
static FACTORY: std::sync::OnceLock<fn() -> reqwest::blocking::ClientBuilder> =
    std::sync::OnceLock::new();

#[cfg(cnote_shared_core)]
pub fn set_client_factory(factory: fn() -> reqwest::blocking::ClientBuilder) -> anyhow::Result<()> {
    FACTORY
        .set(factory)
        .map_err(|_| anyhow::anyhow!("HTTP 客户端已初始化"))
}

pub fn client() -> reqwest::blocking::ClientBuilder {
    #[cfg(cnote_shared_core)]
    if let Some(factory) = FACTORY.get() {
        return factory();
    }
    reqwest::blocking::Client::builder()
}
