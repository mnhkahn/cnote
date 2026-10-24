use crate::{theme::Theme, ui::Notebook, updater, workspace::Workspace};
use gpui::{App, KeyBinding, Menu, MenuItem, OsAction, WindowHandle, actions};
use serde_json::json;
actions!(
    cnote,
    [
        Quit,
        NewNote,
        Save,
        Sync,
        ToggleSidebar,
        CheckUpdates,
        Cut,
        Copy,
        Paste,
        SelectAll,
        Undo,
        Redo,
        ShowNotes,
        ShowText,
        ShowDiff,
        ShowCsv,
        ThemeSystem,
        ThemeLight,
        ThemeDark
    ]
);
pub fn install(cx: &mut App, window: WindowHandle<Notebook>) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-1", ShowNotes, None),
        KeyBinding::new("cmd-2", ShowText, None),
        KeyBinding::new("cmd-3", ShowDiff, None),
        KeyBinding::new("cmd-4", ShowCsv, None),
        KeyBinding::new("cmd-n", NewNote, None),
        KeyBinding::new("cmd-s", Save, None),
        KeyBinding::new("cmd-r", Sync, None),
        KeyBinding::new("cmd-\\", ToggleSidebar, None),
        KeyBinding::new("cmd-x", Cut, None),
        KeyBinding::new("cmd-c", Copy, None),
        KeyBinding::new("cmd-v", Paste, None),
        KeyBinding::new("cmd-a", SelectAll, None),
        KeyBinding::new("cmd-z", Undo, None),
        KeyBinding::new("cmd-shift-z", Redo, None),
    ]);
    set_menus(cx, Theme::System);
    // App-menu actions bubble while the active window is borrowed by GPUI.
    // Defer accessing it until the dispatch has released that borrow.
    cx.on_action(move |_: &ThemeSystem, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::System, cx));
        });
    });
    cx.on_action(move |_: &ThemeLight, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Light, cx));
        });
    });
    cx.on_action(move |_: &ThemeDark, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Dark, cx));
        });
    });
    cx.on_action(move |_: &ShowNotes, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, w, cx| v.switch_workspace(Workspace::Notes, w, cx));
        });
    });
    cx.on_action(move |_: &ShowText, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, w, cx| v.switch_workspace(Workspace::Text, w, cx));
        });
    });
    cx.on_action(move |_: &ShowDiff, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, w, cx| v.switch_workspace(Workspace::Diff, w, cx));
        });
    });
    cx.on_action(move |_: &ShowCsv, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, w, cx| v.switch_workspace(Workspace::Csv, w, cx));
        });
    });
    cx.on_action(move |_: &Quit, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.action("close", json!({})));
        });
    });
    cx.on_action(move |_: &NewNote, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, w, cx| {
                v.switch_workspace(Workspace::Notes, w, cx);
                v.action("new", json!({}));
            });
        });
    });
    cx.on_action(move |_: &Save, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.action("save", json!({})));
        });
    });
    cx.on_action(move |_: &Sync, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.action("refresh", json!({})));
        });
    });
    cx.on_action(move |_: &ToggleSidebar, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.action("sidebar", json!({})));
        });
    });
    cx.on_action(move |_: &CheckUpdates, _| {
        let _ = updater::check();
    });
    cx.on_action(move |_: &Cut, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.edit_command("cut"));
        });
    });
    cx.on_action(move |_: &Copy, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.edit_command("copy"));
        });
    });
    cx.on_action(move |_: &Paste, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.edit_command("paste"));
        });
    });
    cx.on_action(move |_: &SelectAll, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.edit_command("selectAll"));
        });
    });
    cx.on_action(move |_: &Undo, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.edit_command("undo"));
        });
    });
    cx.on_action(move |_: &Redo, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, _| v.edit_command("redo"));
        });
    });
}

pub fn set_menus(cx: &mut App, theme: Theme) {
    cx.set_menus([
        Menu::new("CNote").items([MenuItem::action("退出 CNote", Quit)]),
        Menu::new("文件").items([
            MenuItem::action("新建笔记…", NewNote),
            MenuItem::action("保存并同步笔记", Save),
            MenuItem::action("刷新云端笔记", Sync),
        ]),
        Menu::new("编辑").items([
            MenuItem::os_action("撤销", Undo, OsAction::Undo),
            MenuItem::os_action("重做", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("剪切", Cut, OsAction::Cut),
            MenuItem::os_action("复制", Copy, OsAction::Copy),
            MenuItem::os_action("粘贴", Paste, OsAction::Paste),
            MenuItem::os_action("全选", SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("视图").items([
            MenuItem::action("笔记", ShowNotes),
            MenuItem::action("文本处理", ShowText),
            MenuItem::action("文本对比", ShowDiff),
            MenuItem::action("CSV 表格", ShowCsv),
            MenuItem::separator(),
            MenuItem::action("显示 / 隐藏侧栏", ToggleSidebar),
            MenuItem::submenu(Menu::new("主题").items([
                MenuItem::action("跟随系统", ThemeSystem).checked(theme == Theme::System),
                MenuItem::action("浅色", ThemeLight).checked(theme == Theme::Light),
                MenuItem::action("深色", ThemeDark).checked(theme == Theme::Dark),
            ])),
        ]),
        Menu::new("窗口").items([MenuItem::action("检查更新…", CheckUpdates)]),
    ]);
}
