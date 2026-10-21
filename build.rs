fn main() {
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
