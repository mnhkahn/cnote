#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod analytics;
mod cloud;
mod engine;
mod icons;
mod menus;
mod store;
mod ui;
mod updater;
mod workspace;
use gpui::{App, AppContext, Bounds, TitlebarOptions, WindowBounds, WindowOptions, px, size};
use std::borrow::Cow;
fn main() {
    if let Err(e) = run() {
        eprintln!("CNote: {e:#}");
        std::process::exit(1);
    }
}
fn run() -> anyhow::Result<()> {
    let data = directories::ProjectDirs::from("com", "cyeam", "CNote")
        .ok_or_else(|| anyhow::anyhow!("找不到应用数据目录"))?;
    let directory = std::env::var_os("CNOTE_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| data.data_dir().to_owned());
    std::fs::create_dir_all(&directory)?;
    // User content is private even on shared machines.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    analytics::start(directory.clone());
    let engine = engine::start(directory.join("notes.db"));
    let application = gpui_platform::application();
    let (url_tx, url_rx) = async_channel::unbounded();
    // Register before launch so cold-start URLs wait for the window to exist.
    application.on_open_urls(move |urls| {
        for url in urls {
            if let Some(page) = workspace::Workspace::from_url(&url) {
                let _ = url_tx.try_send(page);
            }
        }
    });
    application.run(move |cx: &mut App| {
        if let Err(e) = cx
            .text_system()
            .add_fonts(vec![Cow::Borrowed(include_bytes!(
                "../assets/bootstrap-icons.ttf"
            ))])
        {
            eprintln!("CNote icons: {e}");
        }
        if cfg!(debug_assertions) && std::env::var_os("CNOTE_SMOKE_TEST").is_some() {
            if let Err(e) = icons::verify_native(cx.text_system()) {
                eprintln!("CNOTE_SMOKE_ICONS_FAILED: {e:#}");
                cx.quit();
                return;
            }
            eprintln!("CNOTE_SMOKE_ICONS_OK");
        }
        let bounds = Bounds::centered(None, size(px(1180.), px(800.)), cx);
        let result = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("CNote".into()),
                    ..Default::default()
                }),
                window_min_size: Some(size(px(760.), px(520.))),
                ..Default::default()
            },
            move |window, cx| cx.new(|cx| ui::Notebook::new(window, cx, engine)),
        );
        let window = match result {
            Ok(window) => window,
            Err(e) => {
                eprintln!("CNote window: {e:#}");
                cx.quit();
                return;
            }
        };
        menus::install(cx, window);
        cx.spawn(async move |cx| {
            while let Ok(page) = url_rx.recv().await {
                if window
                    .update(cx, |notebook, window, cx| {
                        notebook.switch_workspace(page, window, cx);
                        window.activate_window();
                        cx.activate(true);
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        updater::start();
        updater::set_blocked(false);
        cx.activate(true);
    });
    analytics::shutdown();
    Ok(())
}
