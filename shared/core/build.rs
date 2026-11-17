fn main() {
    println!("cargo:rustc-check-cfg=cfg(cnote_shared_core)");
    println!("cargo:rustc-cfg=cnote_shared_core");
    println!("cargo:rerun-if-env-changed=CNOTE_APP_VERSION");
    println!("cargo:rerun-if-env-changed=CNOTE_TRELLO_API_KEY");
    let version = std::env::var("CNOTE_APP_VERSION").unwrap_or_else(|_| "0.1.0".into());
    println!("cargo:rustc-env=CNOTE_APP_VERSION={version}");
}
