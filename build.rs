fn main() {
    println!("cargo:rerun-if-env-changed=CNOTE_APP_VERSION");
    let version = std::env::var("CNOTE_APP_VERSION")
        .unwrap_or_else(|_| std::env::var("CARGO_PKG_VERSION").unwrap());
    let parts: Vec<_> = version.split('.').collect();
    assert!(
        parts.len() == 3
            && parts.iter().all(|part| {
                !part.is_empty()
                    && part.bytes().all(|byte| byte.is_ascii_digit())
                    && (part.len() == 1 || !part.starts_with('0'))
            }),
        "CNOTE_APP_VERSION must be a stable version such as 1.2.3"
    );
    println!("cargo:rustc-env=CNOTE_APP_VERSION={version}");
    println!("cargo:rerun-if-changed=src/updater.m");
    println!("cargo:rerun-if-changed=src/workspace.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/updater.m")
            .file("src/workspace.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("cnote_updater");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AppKit");
    }
}
