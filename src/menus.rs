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
        ThemeDark,
        ThemeSepia,
        ThemeSakura,
        ThemeMint,
        ThemeLavender,
        ThemeSand,
        ThemeArctic,
        ThemeSolarizedLight,
        ThemeIvory,
        ThemeSky,
        ThemeNord,
        ThemeForest,
        ThemeDracula,
        ThemeMonokai,
        ThemeMidnight,
        ThemeOcean,
        ThemeGruvbox,
        ThemeSolarizedDark,
        ThemeCharcoal,
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
    cx.on_action(move |_: &ThemeSepia, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Sepia, cx));
        });
    });
    cx.on_action(move |_: &ThemeSakura, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Sakura, cx));
        });
    });
    cx.on_action(move |_: &ThemeMint, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Mint, cx));
        });
    });
    cx.on_action(move |_: &ThemeLavender, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Lavender, cx));
        });
    });
    cx.on_action(move |_: &ThemeSand, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Sand, cx));
        });
    });
    cx.on_action(move |_: &ThemeArctic, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Arctic, cx));
        });
    });
    cx.on_action(move |_: &ThemeSolarizedLight, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::SolarizedLight, cx));
        });
    });
    cx.on_action(move |_: &ThemeIvory, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Ivory, cx));
        });
    });
    cx.on_action(move |_: &ThemeSky, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Sky, cx));
        });
    });
    cx.on_action(move |_: &ThemeNord, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Nord, cx));
        });
    });
    cx.on_action(move |_: &ThemeForest, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Forest, cx));
        });
    });
    cx.on_action(move |_: &ThemeDracula, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Dracula, cx));
        });
    });
    cx.on_action(move |_: &ThemeMonokai, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Monokai, cx));
        });
    });
    cx.on_action(move |_: &ThemeMidnight, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Midnight, cx));
        });
    });
    cx.on_action(move |_: &ThemeOcean, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Ocean, cx));
        });
    });
    cx.on_action(move |_: &ThemeGruvbox, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Gruvbox, cx));
        });
    });
    cx.on_action(move |_: &ThemeSolarizedDark, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::SolarizedDark, cx));
        });
    });
    cx.on_action(move |_: &ThemeCharcoal, cx| {
        cx.defer(move |cx| {
            let _ = window.update(cx, |v, _, cx| v.set_theme(Theme::Charcoal, cx));
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
            MenuItem::submenu(
                Menu::new("主题").items([
                    MenuItem::action(Theme::System.label(), ThemeSystem)
                        .checked(theme == Theme::System),
                    MenuItem::action(Theme::Light.label(), ThemeLight)
                        .checked(theme == Theme::Light),
                    MenuItem::action(Theme::Dark.label(), ThemeDark).checked(theme == Theme::Dark),
                    MenuItem::action(Theme::Sepia.label(), ThemeSepia)
                        .checked(theme == Theme::Sepia),
                    MenuItem::action(Theme::Sakura.label(), ThemeSakura)
                        .checked(theme == Theme::Sakura),
                    MenuItem::action(Theme::Mint.label(), ThemeMint).checked(theme == Theme::Mint),
                    MenuItem::action(Theme::Lavender.label(), ThemeLavender)
                        .checked(theme == Theme::Lavender),
                    MenuItem::action(Theme::Sand.label(), ThemeSand).checked(theme == Theme::Sand),
                    MenuItem::action(Theme::Arctic.label(), ThemeArctic)
                        .checked(theme == Theme::Arctic),
                    MenuItem::action(Theme::SolarizedLight.label(), ThemeSolarizedLight)
                        .checked(theme == Theme::SolarizedLight),
                    MenuItem::action(Theme::Ivory.label(), ThemeIvory)
                        .checked(theme == Theme::Ivory),
                    MenuItem::action(Theme::Sky.label(), ThemeSky).checked(theme == Theme::Sky),
                    MenuItem::action(Theme::Nord.label(), ThemeNord).checked(theme == Theme::Nord),
                    MenuItem::action(Theme::Forest.label(), ThemeForest)
                        .checked(theme == Theme::Forest),
                    MenuItem::action(Theme::Dracula.label(), ThemeDracula)
                        .checked(theme == Theme::Dracula),
                    MenuItem::action(Theme::Monokai.label(), ThemeMonokai)
                        .checked(theme == Theme::Monokai),
                    MenuItem::action(Theme::Midnight.label(), ThemeMidnight)
                        .checked(theme == Theme::Midnight),
                    MenuItem::action(Theme::Ocean.label(), ThemeOcean)
                        .checked(theme == Theme::Ocean),
                    MenuItem::action(Theme::Gruvbox.label(), ThemeGruvbox)
                        .checked(theme == Theme::Gruvbox),
                    MenuItem::action(Theme::SolarizedDark.label(), ThemeSolarizedDark)
                        .checked(theme == Theme::SolarizedDark),
                    MenuItem::action(Theme::Charcoal.label(), ThemeCharcoal)
                        .checked(theme == Theme::Charcoal),
                ]),
            ),
        ]),
        Menu::new("窗口").items([MenuItem::action("检查更新…", CheckUpdates)]),
    ]);
}
