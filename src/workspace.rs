//! Local workspaces and Cocoa shortcuts that work while WKWebView owns focus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub enum Workspace {
    Notes,
    Text,
    Diff,
    Csv,
}
impl Workspace {
    pub const ALL: [Self; 4] = [Self::Notes, Self::Text, Self::Diff, Self::Csv];
    pub fn index(self) -> usize {
        self as usize
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Notes => "笔记",
            Self::Text => "文本",
            Self::Diff => "Diff",
            Self::Csv => "CSV",
        }
    }
    pub fn icon(self) -> &'static str {
        match self {
            Self::Notes => "journal-text",
            Self::Text => "code-slash",
            Self::Diff => "file-diff",
            Self::Csv => "table",
        }
    }
    /// Public website entry points. URLs only select a workspace.
    pub fn from_url(value: &str) -> Option<Self> {
        if value.len() > 128 {
            return None;
        }
        let url = url::Url::parse(value).ok()?;
        if url.scheme() != "cnote"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        match (url.host_str()?, url.path().trim_end_matches('/')) {
            ("open", "") => Some(Self::Notes),
            ("tool", "/text") => Some(Self::Text),
            ("tool", "/diff") => Some(Self::Diff),
            ("tool", "/csv") => Some(Self::Csv),
            _ => None,
        }
    }
    pub fn from_message(message: &str) -> Option<Self> {
        if message.len() > 128 {
            return None;
        }
        let value: serde_json::Value = serde_json::from_str(message).ok()?;
        if value["type"] != "workspace" {
            return None;
        }
        let index = usize::try_from(value["index"].as_u64()?).ok()?;
        Self::ALL.get(index).copied()
    }
}
pub const SHORTCUT_SCRIPT: &str = include_str!("../editor/workspace.js");

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shortcuts_map_to_local_workspaces() {
        for page in Workspace::ALL {
            assert_eq!(
                Workspace::from_message(&format!(
                    r#"{{"type":"workspace","index":{}}}"#,
                    page.index()
                )),
                Some(page)
            );
        }
    }
    #[test]
    fn website_urls_select_the_four_workspaces() {
        for (url, page) in [
            ("cnote://open", Workspace::Notes),
            ("cnote://tool/text", Workspace::Text),
            ("cnote://tool/diff", Workspace::Diff),
            ("cnote://tool/csv", Workspace::Csv),
        ] {
            assert_eq!(Workspace::from_url(url), Some(page));
            assert_eq!(Workspace::from_url(&format!("{url}/")), Some(page));
        }
    }
    #[test]
    fn website_urls_reject_unknown_routes_and_parameters() {
        for url in [
            "https://tool/text",
            "cnote://tool/delete",
            "cnote://open/note",
            "cnote://tool/text?content=overwrite",
            "cnote://tool/text#fragment",
            "cnote://user@tool/text",
            "cnote://tool:123/text",
            "cnote:///tool/text",
            "invalid",
        ] {
            assert_eq!(Workspace::from_url(url), None, "{url}");
        }
    }
    #[test]
    fn remote_ipc_cannot_issue_notebook_commands() {
        for message in [
            r#"{"type":"change","html":"overwrite"}"#,
            r#"{"type":"logout"}"#,
            r#"{"type":"delete","id":"private"}"#,
            r#"{"type":"workspace","index":-1}"#,
            r#"{"type":"workspace","index":4}"#,
            r#"{"type":"workspace","index":"1"}"#,
            "invalid",
        ] {
            assert_eq!(Workspace::from_message(message), None);
        }
    }
}

static SHORTCUTS: std::sync::OnceLock<async_channel::Sender<Workspace>> =
    std::sync::OnceLock::new();
unsafe extern "C" {
    fn cnote_workspace_install(callback: extern "C" fn(u32)) -> std::ffi::c_int;
    fn cnote_workspace_test_key(index: u32);
    fn cnote_workspace_test_navigation(index: u32, shift: std::ffi::c_int);
}
extern "C" fn shortcut(index: u32) {
    if let Some(page) = Workspace::ALL.get(index as usize)
        && let Some(tx) = SHORTCUTS.get()
    {
        let _ = tx.try_send(*page);
    }
}
pub fn install_shortcuts(tx: async_channel::Sender<Workspace>) {
    let _ = SHORTCUTS.set(tx);
    // Installed on the Cocoa main thread after creating the main window.
    if unsafe { cnote_workspace_install(shortcut) } == 0 {
        eprintln!("CNote: 原生工作区快捷键安装失败");
    }
}
pub fn test_key(page: Workspace) {
    unsafe {
        cnote_workspace_test_key(page.index() as u32);
    }
}

pub fn test_navigation(index: u32, shift: bool) {
    unsafe {
        cnote_workspace_test_navigation(index, i32::from(shift));
    }
}

pub fn smoke_script(page: Workspace) -> String {
    let (ready, action, result) = match page {
        Workspace::Text => (
            "document.querySelector('#tool-text-editor .ace_text-input')",
            "ace.edit('tool-text-editor').setValue('{\"id\":9007199254740993123}',-1);document.querySelector('[data-text-op=format]').click();",
            "cnoteTools.state.text.includes('\\n')&&cnoteTools.state.text.includes('9007199254740993123')",
        ),
        Workspace::Diff => (
            "document.querySelector('#tool-diff-right .ace_text-input')",
            "ace.edit('tool-diff-left').setValue('same\\nold\\n',-1);ace.edit('tool-diff-right').setValue('same\\nnew\\n',-1);document.getElementById('diff-run').click();",
            "document.getElementById('diff-count').textContent==='+1 / −1'",
        ),
        Workspace::Csv => (
            "cnoteTools.workspace===3&&!document.getElementById('local-tools').inert",
            "document.getElementById('table-input').value='name,n\\nx,10\\ny,2';document.getElementById('table-import').click();",
            "cnoteTools.state.rows.length===3&&cnoteTools.state.rows[1][0]==='x'",
        ),
        Workspace::Notes => return String::new(),
    };
    format!(
        r#"(()=>{{let attempts=0;const fail=message=>window.ipc.postMessage(JSON.stringify({{type:'native_tool_smoke',index:{index},error:String(message)}}));const done=()=>window.ipc.postMessage(JSON.stringify({{type:'native_tool_smoke',index:{index}}}));function wait(){{try{{if(!window.cnoteTools||!({ready})){{if(++attempts<200)return setTimeout(wait,25);throw Error('工具初始化超时');}}{action}attempts=0;function poll(){{if({result})return done();if(++attempts<200)return setTimeout(poll,25);fail(document.getElementById('tool-status').textContent);}}poll();}}catch(e){{fail(e.message);}}}}wait();}})();"#,
        index = page.index()
    )
}
