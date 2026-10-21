//! Main-thread adapter for Sparkle. Sparkle verifies archives and installs on quit.
#[cfg(target_os = "macos")]
mod native {
    unsafe extern "C" {
        pub fn cnote_updater_start() -> i32;
        pub fn cnote_updater_available() -> i32;
        pub fn cnote_updater_can_check() -> i32;
        pub fn cnote_updater_check() -> i32;
        pub fn cnote_updater_set_blocked(blocked: i32);
    }
}
pub fn start() {
    #[cfg(target_os = "macos")]
    unsafe {
        native::cnote_updater_start();
    }
}
#[allow(dead_code)]
pub fn available() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        native::cnote_updater_available() != 0
    }
    #[cfg(not(target_os = "macos"))]
    false
}
#[allow(dead_code)]
pub fn can_check() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        native::cnote_updater_can_check() != 0
    }
    #[cfg(not(target_os = "macos"))]
    false
}
pub fn check() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if unsafe { native::cnote_updater_check() != 0 } {
        return Ok(());
    }
    Err("暂时无法检查更新。请使用打包后的 CNote.app，并等待当前编辑保存到本机。".into())
}
pub fn set_blocked(blocked: bool) {
    #[cfg(target_os = "macos")]
    unsafe {
        native::cnote_updater_set_blocked(i32::from(blocked));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = blocked;
}
