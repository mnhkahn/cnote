use crate::{
    engine::{Command, Event, Handle},
    icons,
    store::Summary,
    theme::Theme,
    updater,
    workspace::{self, Workspace},
};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{cell::Cell, path::PathBuf, rc::Rc, sync::mpsc::Sender};

type WebBounds = (f64, f64, f64, f64);
fn smoke() -> bool {
    cfg!(debug_assertions) && std::env::var_os("CNOTE_SMOKE_TEST").is_some()
}
pub struct Notebook {
    intent: u64,
    cache_generation: u64,
    web_bounds: Rc<Cell<Option<WebBounds>>>,
    view: Option<Rc<wry::WebView>>,
    tx: Sender<Command>,
    notes: Rc<Vec<Summary>>,
    selected: Option<String>,
    account: String,
    authenticated: bool,
    sidebar: bool,
    theme: Theme,
    context_menu: Option<(String, Point<Pixels>)>,
    workspace: Workspace,
    note_dirty: bool,
    tool_dirty: bool,
    smoke_shortcuts: usize,
    ready: bool,
    pending: Vec<Event>,
    close_allowed: bool,
    quitting: bool,
    close_tx: async_channel::Sender<()>,
    close_rx: async_channel::Receiver<()>,
    _subscriptions: Vec<Subscription>,
}
impl Notebook {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, handle: Handle) -> Self {
        let (ipc_tx, ipc_rx) = async_channel::unbounded();
        let (close_tx, close_rx) = async_channel::bounded(1);
        let (tool_messages, tool_rx) = async_channel::bounded(16);
        workspace::install_shortcuts(tool_messages);
        cx.spawn(async move |this, cx| {
            while let Ok(page) = tool_rx.recv().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        this.switch_workspace(page, window, cx);
                        if smoke() && this.smoke_shortcuts < 4 {
                            let expected = [
                                Workspace::Text,
                                Workspace::Diff,
                                Workspace::Csv,
                                Workspace::Notes,
                            ];
                            assert_eq!(page, expected[this.smoke_shortcuts]);
                            this.smoke_shortcuts += 1;
                            if this.smoke_shortcuts < 4 {
                                this.js(&workspace::smoke_script(page));
                            } else {
                                eprintln!("CNOTE_SMOKE_SHORTCUTS_OK");
                                eprintln!("CNOTE_SMOKE_WORKSPACES_OK");
                                workspace::test_more_menu();
                                let _ = this.tx.send(Command::Web(
                                    json!({"type":"new","title":"Native smoke test"}),
                                ));
                            }
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let html = include_str!("../editor/index.html")
            .replace("/* ICONS */", include_str!("../editor/icons.css"))
            .replace("/* STYLE */", include_str!("../editor/style.css"))
            .replace("/* TOOL_STYLE */", include_str!("../tools/style.css"))
            .replace("<!-- TOOL_HTML -->", include_str!("../tools/index.html"))
            .replace(
                "/* TOOL_WORKER */",
                include_str!("../tools/vendor/worker.b64"),
            )
            .replace("/* TOOL_ACE */", include_str!("../tools/vendor/ace.b64"))
            .replace("/* WORKSPACE */", workspace::SHORTCUT_SCRIPT)
            .replace("/* TOOL_SCRIPT */", include_str!("../tools/tools.js"))
            .replace("/* SCRIPT */", include_str!("../editor/editor.js"));
        let view = wry::WebViewBuilder::new()
            .with_html(html)
            .with_devtools(cfg!(debug_assertions))
            .with_accept_first_mouse(true)
            .with_bounds(wry::Rect {
                position: wry::dpi::LogicalPosition::new(280., 0.).into(),
                size: wry::dpi::LogicalSize::new(900., 750.).into(),
            })
            .with_navigation_handler(|url| url == "about:blank")
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            .with_ipc_handler(move |request| {
                let _ = ipc_tx.try_send(request.into_body());
            })
            .build_as_child(window);
        let (view, error) = match view {
            Ok(v) => (Some(Rc::new(v)), None),
            Err(e) => (None, Some(format!("富文本编辑器无法启动：{e}"))),
        };
        if let Some(error) = error {
            eprintln!("CNote editor: {error}");
        }
        let write_tx = handle.tx.clone();
        cx.spawn(async move |this, cx| {
            while let Ok(message) = ipc_rx.recv().await {
                if message.starts_with("{\"type\":\"change\",")
                    || message.starts_with("{\"type\":\"tool_save\",")
                    || message.starts_with("{\"type\":\"tool_export\",")
                {
                    let _ = write_tx.send(Command::SerializedChange(message));
                    continue;
                }
                if let Ok(v) = serde_json::from_str(&message) {
                    let _ = this.update_in(cx, |this, window, cx| this.ipc(v, window, cx));
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            while let Ok(event) = handle.events.recv().await {
                if this
                    .update_in(cx, |this, window, cx| this.event(event, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            weak.update(cx, |this, _| {
                if this.close_allowed {
                    return true;
                }
                this.action("close", json!({}));
                false
            })
            .unwrap_or(true)
        });
        let quit = cx.on_app_quit(|this, _| {
            this.quitting = true;
            let ready = this.close_allowed || this.view.is_none();
            if !ready {
                this.action("close", json!({}));
            }
            let rx = this.close_rx.clone();
            async move {
                if !ready {
                    let _ = rx.recv().await;
                }
            }
        });
        let activation = cx.observe_window_activation(window, |this, window, _| {
            if window.is_window_active() && this.ready {
                this.action("refresh", json!({}));
            }
        });
        let appearance = cx.observe_window_appearance(window, |_, _, cx| cx.notify());
        Self {
            intent: 0,
            cache_generation: 0,
            web_bounds: Rc::new(Cell::new(None)),
            view,
            tx: handle.tx,
            notes: Rc::new(Vec::new()),
            selected: None,
            account: String::new(),
            authenticated: false,
            sidebar: true,
            theme: Theme::System,
            context_menu: None,
            workspace: Workspace::Notes,
            note_dirty: false,
            tool_dirty: false,
            smoke_shortcuts: 0,
            ready: false,
            pending: Vec::new(),
            close_allowed: false,
            quitting: false,
            close_tx,
            close_rx,
            _subscriptions: vec![quit, activation, appearance],
        }
    }
    fn apply_theme(&mut self, theme: Theme, cx: &mut Context<Self>) {
        self.theme = theme;
        cx.set_window_appearance(theme.appearance());
        crate::menus::set_menus(cx, theme);
        if self.ready {
            self.js(&format!("cnoteTheme.set({})", json!(theme.as_str())));
        }
        cx.notify();
    }
    pub fn set_theme(&mut self, theme: Theme, cx: &mut Context<Self>) {
        self.apply_theme(theme, cx);
        let _ = self
            .tx
            .send(Command::Web(json!({"type":"theme","value":theme.as_str()})));
    }
    fn active_view(&self) -> Option<&Rc<wry::WebView>> {
        self.view.as_ref()
    }
    pub fn edit_command(&self, command: &str) {
        if let Some(view) = self.active_view() {
            let _ = view.evaluate_script(&format!("window.cnoteTools&&cnoteTools.workspace?cnoteTools.edit({0}):document.execCommand({0})", json!(command)));
        }
    }
    pub fn switch_workspace(
        &mut self,
        page: Workspace,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if page == self.workspace {
            return;
        }
        self.workspace = page;
        self.context_menu = None;
        self.js(&format!(
            "window.cnoteTools&&cnoteTools.show({})",
            page.index()
        ));
        if let Some(view) = &self.view {
            let _ = view.focus();
        }
        let _ = window;
        cx.notify();
    }
    fn workspace_bar(&self, dark: bool, muted: u32, cx: &Context<Self>) -> impl IntoElement {
        let tray = if dark { 0x101520 } else { 0xe9edf3 };
        let selected_bg = if dark { 0x30394a } else { 0xffffff };
        div()
            .flex()
            .gap_1()
            .p_1()
            .rounded_lg()
            .bg(rgb(tray))
            .children(Workspace::ALL.into_iter().map(|page| {
                let selected = self.workspace == page;
                div()
                    .id(("workspace", page.index()))
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .h(px(30.))
                    .rounded_md()
                    .cursor_pointer()
                    .text_color(rgb(if selected { 0x0d6efd } else { muted }))
                    .when(selected, |d| d.bg(rgb(selected_bg)).shadow_sm())
                    .hover(|d| d.bg(rgb(selected_bg)))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .font_family("bootstrap-icons")
                            .text_size(px(14.))
                            .child(icons::glyph(page.icon())),
                    )
                    .child(div().text_size(px(12.)).child(page.label()))
                    .child(
                        div()
                            .text_size(px(10.))
                            .text_color(rgb(muted))
                            .child(format!("⌘{}", page.index() + 1)),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.switch_workspace(page, window, cx)
                    }))
            }))
    }
    pub fn js(&self, script: &str) {
        if let Some(view) = &self.view
            && let Err(e) = view.evaluate_script(script)
        {
            eprintln!("CNote editor: {e}");
        }
    }
    fn deliver(&self, event: Event, cx: &mut Context<Self>) {
        if matches!(&event, Event::Load { .. }) {
            let generation = self.cache_generation;
            let smoke_load = smoke() && matches!(&event, Event::Load { id, .. } if !id.is_empty());
            cx.spawn(async move |this, cx| {
                let serialized = cx
                    .background_executor()
                    .spawn(async move { serde_json::to_string(&event) })
                    .await;
                if let Ok(serialized) = serialized {
                    let _ = this.update(cx, |this, _| {
                        if this.cache_generation == generation {
                            this.js(&format!("window.cnote&&cnote.receive({serialized})"));
                            if smoke_load {
                                this.js("const editor=document.getElementById('editor');editor.innerHTML='<p>first</p><p>second</p><p>third</p>';editor.focus();const range=document.createRange();range.setStart(editor.firstChild.firstChild,0);range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range)");
                                workspace::test_navigation(2, false);
                                this.js("setTimeout(()=>{window.ipc.postMessage(JSON.stringify({type:'native_note_navigation_smoke',html:document.getElementById('editor').innerHTML,anchor:getSelection().anchorNode?.textContent}));},200)");
                            }
                        }
                    });
                }
            })
            .detach();
        } else if let Ok(s) = serde_json::to_string(&event) {
            self.js(&format!("window.cnote&&cnote.receive({s})"));
        }
    }
    pub fn action(&self, kind: &str, data: Value) {
        self.js(&format!(
            "window.cnote&&cnote.action({},{})",
            json!(kind),
            data
        ));
    }
    fn verify_smoke_layout(&self) {
        let (x, y, width, height) = self.web_bounds.get().expect("editor layout");
        let expected_x = if self.workspace == Workspace::Notes && self.sidebar {
            270.
        } else {
            0.
        };
        assert_eq!(x, expected_x, "sidebar only occupies space in Notes");
        assert_eq!(y, 56., "all workspaces start below the shared titlebar");
        assert!(width > 400. && height > 400., "usable editor dimensions");
    }
    fn ipc(&mut self, v: Value, window: &mut Window, cx: &mut Context<Self>) {
        match v["type"].as_str().unwrap_or_default() {
            "native_note_navigation_smoke" if smoke() => {
                if v["html"] != "<p>first</p><p>second</p><p>third</p>" || v["anchor"] != "second" {
                    eprintln!("CNOTE_SMOKE_NOTE_NAVIGATION_FAILED: {v}");
                    cx.quit();
                    return;
                }
                self.verify_smoke_layout();
                assert_eq!(
                    self.theme,
                    Theme::Dark,
                    "More menu must dispatch its theme action"
                );
                eprintln!("CNOTE_SMOKE_TITLEBAR_OK");
                eprintln!("CNOTE_SMOKE_NOTE_NAVIGATION_OK");
                self.js("document.getElementById('editor').innerHTML='<p>Native WebKit → IPC → SQLite ✓</p>';document.getElementById('editor').dispatchEvent(new Event('input',{bubbles:true}))");
                self.switch_workspace(Workspace::Csv, window, cx);
                self.js("cnote.action('close')");
            }
            "native_tool_smoke" if smoke() => {
                self.verify_smoke_layout();
                if let Some(error) = v["error"].as_str() {
                    eprintln!("CNOTE_SMOKE_TOOL_FAILED: {error}");
                    cx.quit();
                    return;
                }
                if self.workspace == Workspace::Text
                    && !v["navigation_checked"].as_bool().unwrap_or(false)
                {
                    self.js("window.navigationOriginal=ace.edit('tool-text-editor').getValue();ace.edit('tool-text-editor').setValue('first\\nsecond\\nthird',-1);ace.edit('tool-text-editor').focus()");
                    workspace::test_navigation(2, false);
                    self.js("(()=>{let attempts=0;function check(){const editor=ace.edit('tool-text-editor');const text=editor.getValue(),row=editor.getCursorPosition().row;const unchanged=text==='first\\nsecond\\nthird';if(unchanged&&row!==1&&++attempts<80)return setTimeout(check,25);editor.setValue(window.navigationOriginal,-1);window.ipc.postMessage(JSON.stringify({type:'native_tool_smoke',index:1,navigation_checked:true,...(unchanged&&row===1?{}:{error:'ArrowDown changed text or did not move: '+JSON.stringify({text,row})})}));}setTimeout(check,25);})()");
                    return;
                }
                if v["navigation_checked"].as_bool() == Some(true) {
                    eprintln!("CNOTE_SMOKE_NAVIGATION_OK");
                }
                let expected = [
                    Workspace::Text,
                    Workspace::Diff,
                    Workspace::Csv,
                    Workspace::Notes,
                ];
                if self.smoke_shortcuts > 0
                    && self.smoke_shortcuts < 4
                    && v["index"].as_u64() == Some(self.workspace.index() as u64)
                {
                    eprintln!("CNOTE_SMOKE_LOCAL_TOOL_OK: {}", self.workspace.label());
                    workspace::test_key(expected[self.smoke_shortcuts]);
                }
            }
            "workspace" => {
                if let Some(page) = Workspace::from_message(&v.to_string()) {
                    self.switch_workspace(page, window, cx);
                }
            }
            "ready" => {
                self.ready = true;
                // A launch URL may select a tool before the web page is ready.
                self.js(&format!("cnoteTools.show({})", self.workspace.index()));
                for e in std::mem::take(&mut self.pending) {
                    self.deliver(e, cx);
                }
                let _ = self.tx.send(Command::Web(v));
                if smoke() {
                    eprintln!("CNOTE_SMOKE_READY");
                    if let Some(view) = &self.view {
                        let _ = view.focus();
                    }
                    workspace::test_key(Workspace::Text);
                }
            }
            "navigation" => {
                self.intent = self.intent.max(v["intent"].as_u64().unwrap_or(0));
                if let Some(id) = v["id"].as_str() {
                    self.selected = Some(id.into());
                }
                cx.notify();
            }
            "dirty" => {
                self.note_dirty = true;
                updater::set_blocked(true);
            }
            "clean" => {
                self.note_dirty = false;
                updater::set_blocked(self.tool_dirty);
            }
            "tool_guard" => {
                self.tool_dirty = v["dirty"].as_bool().unwrap_or(true);
                updater::set_blocked(self.note_dirty || self.tool_dirty);
            }
            "sidebar" => {
                self.sidebar = !self.sidebar;
                cx.notify();
            }
            "link" => {
                if let Some(s) = v["url"].as_str()
                    && let Ok(url) = url::Url::parse(s)
                    && matches!(url.scheme(), "http" | "https" | "mailto")
                {
                    cx.open_url(url.as_str());
                }
            }
            "print" => {
                if let Some(view) = &self.view
                    && let Err(e) = view.print()
                {
                    self.js(&format!(
                        "window.cnote&&cnote.receive({})",
                        json!({"type":"error","message":format!("无法打开打印窗口：{e}")})
                    ));
                }
            }
            "export" => self.export(v, cx),
            _ => {
                let _ = self.tx.send(Command::Web(v));
            }
        }
    }
    fn export(&self, v: Value, cx: &mut Context<Self>) {
        let title = v["title"]
            .as_str()
            .unwrap_or("笔记")
            .replace(['/', '\\', ':'], "_");
        let html = v["html"].as_str().unwrap_or("").to_owned();
        let name = format!("{title}.html");
        let directory = directories::UserDirs::new()
            .and_then(|d| d.document_dir().map(PathBuf::from))
            .unwrap_or_else(std::env::temp_dir);
        let prompt = cx.prompt_for_new_path(&directory, Some(&name));
        cx.spawn(async move|this,cx|{
            if let Ok(Ok(Some(path)))=prompt.await{
                let result=cx.background_executor().spawn(async move{
                    let document=format!("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><body>{html}</body></html>");
                    std::fs::write(&path,document)
                }).await;
                let _=this.update(cx,|this,_|{let status=match result{Ok(())=>"HTML 已导出".into(),Err(e)=>format!("导出失败：{e}")};this.js(&format!("window.cnote&&cnote.receive({})",json!({"type":"state","status":status})));});
            }
        }).detach();
    }
    fn export_tool(&self, filename: String, bytes: Vec<u8>, cx: &mut Context<Self>) {
        let directory = directories::UserDirs::new()
            .and_then(|d| d.document_dir().map(PathBuf::from))
            .unwrap_or_else(std::env::temp_dir);
        let prompt = cx.prompt_for_new_path(&directory, Some(&filename));
        cx.spawn(async move |this,cx| {
            if let Ok(Ok(Some(path)))=prompt.await {
                let result=cx.background_executor().spawn(async move { std::fs::write(path,bytes) }).await;
                let _=this.update(cx,|this,_|this.js(&format!("cnoteTools.receive({})",json!({"type":"tool_export_done","failed":result.is_err(),"message":match result {Ok(())=>"文件已导出".to_string(),Err(e)=>format!("导出失败：{e}")}}))));
            }
        }).detach();
    }
    fn event(&mut self, event: Event, _window: &mut Window, cx: &mut Context<Self>) {
        if let Event::State {
            cache_generation,
            cache_account,
            ..
        } = &event
            && *cache_generation >= self.cache_generation
        {
            self.cache_generation = *cache_generation;
            self.js(&format!(
                "window.cnote&&cnote.receive({})",
                json!({"type":"cache_reset","generation":cache_generation,"account":cache_account})
            ));
        }
        if let Event::Preload { generation, script } = &event {
            if self.ready && *generation == self.cache_generation {
                self.js(script);
            }
            return;
        }
        if let Event::ToolExport { filename, bytes } = event {
            self.export_tool(filename, bytes, cx);
            return;
        }
        if matches!(&event,Event::State{intent,..}|Event::Load{intent,..}|Event::Selected{intent,..} if *intent<self.intent)
        {
            return;
        }
        let mut redraw = false;
        match &event {
            Event::Theme { theme } => self.apply_theme(*theme, cx),
            Event::State {
                notes,
                selected,
                account,
                authenticated,
                intent,
                ..
            } => {
                self.intent = self.intent.max(*intent);
                redraw = true;
                self.notes = Rc::new(notes.clone());
                self.selected = selected.clone();
                self.account = account.clone();
                self.authenticated = *authenticated;
            }
            Event::Selected { id, intent } => {
                self.intent = self.intent.max(*intent);
                if self.selected.as_deref() != Some(id) {
                    self.selected = Some(id.clone());
                    redraw = true;
                }
            }
            Event::Saved { id, title, .. } | Event::Title { id, title } => {
                let saved = matches!(&event, Event::Saved { .. });
                if let Some(index) = self
                    .notes
                    .iter()
                    .position(|n| &n.id == id && ((saved && !n.dirty) || &n.title != title))
                {
                    let note = &mut Rc::make_mut(&mut self.notes)[index];
                    note.dirty |= saved;
                    note.title = title.clone();
                    redraw = true;
                }
            }
            Event::Error { .. } | Event::SaveFailed { .. } => {}
            Event::Closed => {
                if smoke() {
                    eprintln!("CNOTE_SMOKE_SAVED");
                }
                self.close_allowed = true;
                let _ = self.close_tx.try_send(());
                if !self.quitting {
                    cx.quit();
                }
                return;
            }
            _ => {}
        }
        if self.ready {
            self.deliver(event, cx);
        } else {
            self.pending.push(event);
        }
        if redraw {
            cx.notify();
        }
    }
    fn button(
        &self,
        id: &'static str,
        icon: &str,
        label: &str,
        kind: &str,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let kind = kind.to_string();
        div()
            .id(id)
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .py_2()
            .rounded_md()
            .cursor_pointer()
            .hover(|d| d.bg(rgba(0x8ba4cc18)))
            .child(
                div()
                    .font_family("bootstrap-icons")
                    .text_size(px(15.))
                    .child(icons::glyph(icon)),
            )
            .child(label.to_string())
            .on_click(cx.listener(move |this, _, _, cx| match kind.as_str() {
                "sidebar" => {
                    this.sidebar = !this.sidebar;
                    cx.notify();
                }
                "update" => {
                    if let Err(e) = updater::check() {
                        this.js(&format!(
                            "window.cnote&&cnote.receive({})",
                            json!({"type":"error","message":e})
                        ));
                    }
                }
                _ => this.action(&kind, json!({})),
            }))
    }
}
impl Render for Notebook {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.theme.is_dark(window.appearance());
        let (bg, sidebar, ink, muted, line, active) = if dark {
            (0x191e29, 0x151a24, 0xdfe7f3, 0x8390a4, 0x2b3240, 0x233c63)
        } else {
            (0xffffff, 0xf6f8fb, 0x253047, 0x8792a2, 0xe7ecf3, 0xe7f0ff)
        };
        let notes = self.notes.clone();
        let selected = self.selected.clone();
        let weak = cx.weak_entity();
        let list = uniform_list("notes", notes.len(), move |range, _, _cx| {
            range
                .map(|i| {
                    let n = &notes[i];
                    let id = n.id.clone();
                    let chosen = selected.as_deref() == Some(id.as_str());
                    let weak = weak.clone();
                    let menu_id = id.clone();
                    let menu_weak = weak.clone();
                    div()
                        .id(SharedString::from(id.clone()))
                        .w_full()
                        .min_w_0()
                        .h(px(44.))
                        .flex()
                        .flex_col()
                        .justify_center()
                        .gap(px(2.))
                        .px_4()
                        .py_1()
                        .cursor_pointer()
                        .bg(if chosen { rgb(active) } else { rgb(sidebar) })
                        .hover(|d| d.bg(rgb(active)))
                        .child(
                            div()
                                .w_full()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .line_height(px(18.))
                                .child(
                                    div()
                                        .font_family("bootstrap-icons")
                                        .text_size(px(14.))
                                        .text_color(rgb(if chosen { 0x0d6efd } else { muted }))
                                        .child(icons::glyph("file-earmark-text")),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .text_ellipsis()
                                        .text_size(px(13.))
                                        .child(n.title.clone()),
                                )
                                .when(n.dirty || n.conflict, |d| {
                                    d.child(
                                        div()
                                            .text_color(rgb(if n.conflict {
                                                0xe5a246
                                            } else {
                                                0x76a5e9
                                            }))
                                            .child("•"),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .ml(px(20.))
                                .text_size(px(10.))
                                .line_height(px(12.))
                                .text_color(rgb(muted))
                                .child(if n.conflict {
                                    "版本冲突 · 草稿已保留"
                                } else if n.dirty {
                                    "已存本机 · 等待同步"
                                } else {
                                    "OneDrive"
                                }),
                        )
                        .on_click(move |_, window, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.switch_workspace(Workspace::Notes, window, cx);
                                this.selected = Some(id.clone());
                                cx.notify();
                                this.action("open", json!({"id":id}));
                            });
                        })
                        .on_mouse_down(MouseButton::Right, move |event, _, cx| {
                            let _ = menu_weak.update(cx, |this, cx| {
                                this.context_menu = Some((menu_id.clone(), event.position));
                                cx.notify();
                            });
                        })
                })
                .collect::<Vec<_>>()
        })
        .w_full()
        .flex_1()
        .min_h_0();
        let sidebar_view = div()
            .w(px(270.))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(sidebar))
            .border_r_1()
            .border_color(rgb(line))
            .child(
                div()
                    .px_5()
                    .pt_4()
                    .pb_4()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .font_family("bootstrap-icons")
                            .text_color(rgb(0x0d6efd))
                            .text_size(px(25.))
                            .child(icons::glyph("journal-text")),
                    )
                    .child(
                        div()
                            .text_size(px(22.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("CNote"),
                    ),
            )
            .when(self.workspace == Workspace::Notes, |d| {
                d.child(
                    div()
                        .px_3()
                        .pb_3()
                        .text_size(px(12.))
                        .text_color(rgb(muted))
                        .child(self.button("new", "plus-lg", "新建笔记", "new", cx)),
                )
                .child(
                    div()
                        .px_4()
                        .py_2()
                        .flex()
                        .justify_between()
                        .text_size(px(10.))
                        .text_color(rgb(muted))
                        .child("我的笔记")
                        .child(format!("{:02}", self.notes.len())),
                )
                .child(list)
                .when(self.notes.is_empty(), |d| {
                    d.child(
                        div()
                            .px_5()
                            .py_4()
                            .text_size(px(12.))
                            .text_color(rgb(muted))
                            .child("点击上方新建，开始记录。"),
                    )
                })
                .child(
                    div()
                        .border_t_1()
                        .border_color(rgb(line))
                        .p_3()
                        .text_size(px(12.))
                        .text_color(rgb(muted))
                        .child(self.button(
                            "login",
                            "cloud",
                            if self.authenticated {
                                "注销 OneDrive"
                            } else {
                                "登录 OneDrive"
                            },
                            if self.authenticated {
                                "logout"
                            } else {
                                "login"
                            },
                            cx,
                        ))
                        .when(!self.account.is_empty(), |d| {
                            d.child(
                                div()
                                    .px_3()
                                    .text_size(px(10.))
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .child(self.account.clone()),
                            )
                        })
                        .child(self.button("refresh", "arrow-repeat", "同步笔记 ⌘S", "save", cx)),
                )
            });
        let view = self.active_view().cloned();
        let last = self.web_bounds.clone();
        let editor = canvas(
            move |bounds, _, _| bounds,
            move |bounds, _, _, _| {
                if let Some(view) = view {
                    let tuple = (
                        f64::from(bounds.origin.x),
                        f64::from(bounds.origin.y),
                        f64::from(bounds.size.width),
                        f64::from(bounds.size.height),
                    );
                    if last.get() != Some(tuple) {
                        let _ = view.set_bounds(wry::Rect {
                            position: wry::dpi::LogicalPosition::new(tuple.0, tuple.1).into(),
                            size: wry::dpi::LogicalSize::new(tuple.2, tuple.3).into(),
                        });
                        last.set(Some(tuple));
                    }
                }
            },
        )
        .size_full();
        div()
            .size_full()
            .flex()
            .flex_col()
            .relative()
            .bg(rgb(bg))
            .text_color(rgb(ink))
            .font_family(".AppleSystemUIFont")
            .child(
                div()
                    .id("titlebar")
                    .h(px(56.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px_3()
                    .bg(rgb(sidebar))
                    .border_b_1()
                    .border_color(rgb(line))
                    .on_mouse_down(MouseButton::Left, |event, window, _| {
                        if event.click_count == 2 {
                            window.zoom_window();
                        } else {
                            window.start_window_move();
                        }
                    })
                    .child(div().w(px(140.)).flex_none().pl(px(76.)).when(
                        self.workspace == Workspace::Notes,
                        |d| {
                            d.child(
                                div()
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation()
                                    })
                                    .child(self.button(
                                        "sidebar",
                                        "layout-sidebar",
                                        "",
                                        "sidebar",
                                        cx,
                                    )),
                            )
                        },
                    ))
                    .child(self.workspace_bar(dark, muted, cx))
                    .child(
                        div().w(px(140.)).flex_none().flex().justify_end().child(
                            div()
                                .id("workspace-more")
                                .w(px(36.))
                                .h(px(32.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_md()
                                .cursor_pointer()
                                .text_size(px(24.))
                                .text_color(rgb(muted))
                                .hover(|d| d.bg(rgb(active)))
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .child("⋯")
                                .on_click(|_, _, _| workspace::show_more_menu()),
                        ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .when(self.sidebar && self.workspace == Workspace::Notes, |d| {
                        d.child(sidebar_view)
                    })
                    .child(div().flex_1().min_w_0().h_full().child(editor)),
            )
            .when_some(self.context_menu.clone(), |d, (_, position)| {
                d.child(
                    div()
                        .id("note-menu")
                        .absolute()
                        .left(position.x)
                        .top(position.y)
                        .w(px(132.))
                        .p_1()
                        .flex()
                        .flex_col()
                        .rounded_md()
                        .border_1()
                        .border_color(rgb(line))
                        .bg(rgb(bg))
                        .shadow_lg()
                        .text_size(px(12.))
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            this.context_menu = None;
                            cx.notify();
                        }))
                        .child(
                            div()
                                .id("note-menu-delete")
                                .cursor_pointer()
                                .flex()
                                .items_center()
                                .gap_2()
                                .px_3()
                                .py_2()
                                .rounded_sm()
                                .hover(|d| d.bg(rgb(active)))
                                .child(
                                    div()
                                        .font_family("bootstrap-icons")
                                        .child(icons::glyph("trash3")),
                                )
                                .child("删除笔记")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if let Some((id, _)) = this.context_menu.take() {
                                        if let Some(n) = this.notes.iter().find(|n| n.id == id) {
                                            this.action("delete", json!({"id":id,"title":n.title}));
                                        }
                                        cx.notify();
                                    }
                                })),
                        ),
                )
            })
    }
}
