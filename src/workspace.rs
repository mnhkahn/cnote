//! Local workspaces and Cocoa shortcuts that work while WKWebView owns focus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub enum Workspace {
    Notes,
    Text,
    Diff,
    Csv,
    Trello,
}
impl Workspace {
    pub const ALL: [Self; 5] = [Self::Notes, Self::Text, Self::Diff, Self::Csv, Self::Trello];
    pub fn index(self) -> usize {
        self as usize
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Notes => "笔记",
            Self::Text => "文本",
            Self::Diff => "Diff",
            Self::Csv => "CSV",
            Self::Trello => "Trello",
        }
    }
    pub fn icon(self) -> &'static str {
        match self {
            Self::Notes => "journal-text",
            Self::Text => "code-slash",
            Self::Diff => "file-diff",
            Self::Csv => "table",
            Self::Trello => "calendar-check",
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
            ("tool", "/trello") => Some(Self::Trello),
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
    fn clipboard_image_data_is_bounded_and_local_urls_are_rejected() {
        assert_eq!(
            image_bytes("data:image/png;base64,aGVsbG8=").unwrap(),
            b"hello"
        );
        for source in [
            "data:image/png;base64,",
            "data:image/png;base64,invalid!",
            "data:image/png,hello",
            "file:///tmp/image.png",
            "http://example.com/image.png",
        ] {
            assert!(image_bytes(source).is_err(), "{source}");
        }
    }
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
    fn website_urls_select_all_workspaces() {
        for (url, page) in [
            ("cnote://open", Workspace::Notes),
            ("cnote://tool/text", Workspace::Text),
            ("cnote://tool/diff", Workspace::Diff),
            ("cnote://tool/csv", Workspace::Csv),
            ("cnote://tool/trello", Workspace::Trello),
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
            r#"{"type":"workspace","index":5}"#,
            r#"{"type":"workspace","index":"1"}"#,
            "invalid",
        ] {
            assert_eq!(Workspace::from_message(message), None);
        }
    }
}

static SHORTCUTS: std::sync::OnceLock<async_channel::Sender<Workspace>> =
    std::sync::OnceLock::new();
type ImageSaveResult = anyhow::Result<Option<std::path::PathBuf>>;
extern "C" fn image_save_selected(
    context: *mut std::ffi::c_void,
    status: std::ffi::c_int,
    path: *const std::ffi::c_char,
) {
    // Native code calls exactly once for every accepted request. Copy the path
    // while its NSURL is still alive; no Cocoa object crosses threads.
    let sender = unsafe { Box::from_raw(context.cast::<async_channel::Sender<ImageSaveResult>>()) };
    let result = match status {
        1 if !path.is_null() => {
            use std::os::unix::ffi::OsStrExt;
            let path = unsafe { std::ffi::CStr::from_ptr(path) };
            Ok(Some(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(
                path.to_bytes(),
            ))))
        }
        0 => Ok(None),
        _ => Err(anyhow::anyhow!("保存窗口异常关闭，请重新选择下载")),
    };
    let _ = sender.try_send(result);
}
/// Must be called on the Cocoa main thread, like other workspace UI adapters.
pub fn prompt_image_save(
    directory: &std::path::Path,
    name: &str,
) -> async_channel::Receiver<ImageSaveResult> {
    let (sender, receiver) = async_channel::bounded(1);
    let result: anyhow::Result<()> = (|| {
        let directory = std::ffi::CString::new(
            directory
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("保存目录格式无效"))?,
        )?;
        let name = std::ffi::CString::new(name)?;
        let context = Box::into_raw(Box::new(sender.clone()));
        let accepted = unsafe {
            cnote_image_save_prompt(
                directory.as_ptr(),
                name.as_ptr(),
                context.cast(),
                image_save_selected,
            )
        };
        if accepted == 0 {
            unsafe {
                drop(Box::from_raw(context));
            }
            anyhow::bail!("无法打开保存窗口：请先关闭已有对话框并重试");
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = sender.try_send(Err(error));
    }
    receiver
}
unsafe extern "C" {
    fn cnote_image_share(
        path: *const std::ffi::c_char,
        context: *mut std::ffi::c_void,
        callback: extern "C" fn(*mut std::ffi::c_void, std::ffi::c_int),
    ) -> std::ffi::c_int;
    fn cnote_image_save_prompt(
        directory: *const std::ffi::c_char,
        name: *const std::ffi::c_char,
        context: *mut std::ffi::c_void,
        callback: extern "C" fn(*mut std::ffi::c_void, std::ffi::c_int, *const std::ffi::c_char),
    ) -> std::ffi::c_int;
    fn cnote_copy_image(
        bytes: *const u8,
        length: usize,
        html: *const std::ffi::c_char,
    ) -> std::ffi::c_int;
    fn cnote_workspace_install(callback: extern "C" fn(u32)) -> std::ffi::c_int;
    fn cnote_workspace_test_key(index: u32);
    fn cnote_workspace_show_more_menu();
    fn cnote_workspace_test_more_menu();
    fn cnote_workspace_test_navigation(index: u32, shift: std::ffi::c_int);
}
type ImageShareResult = anyhow::Result<bool>;

extern "C" fn image_share_finished(context: *mut std::ffi::c_void, status: std::ffi::c_int) {
    let sender =
        unsafe { Box::from_raw(context.cast::<async_channel::Sender<ImageShareResult>>()) };
    let result = match status {
        1 => Ok(true),
        0 => Ok(false),
        _ => Err(anyhow::anyhow!("系统分享未能完成，请重试")),
    };
    let _ = sender.try_send(result);
}

/// Must be called on the Cocoa main thread. Keep the file available until the result arrives.
pub fn share_image(
    path: &std::path::Path,
) -> anyhow::Result<async_channel::Receiver<ImageShareResult>> {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())?;
    let (sender, receiver) = async_channel::bounded(1);
    let context = Box::into_raw(Box::new(sender));
    let accepted =
        unsafe { cnote_image_share(path.as_ptr(), context.cast(), image_share_finished) };
    if accepted == 0 {
        unsafe { drop(Box::from_raw(context)) };
        anyhow::bail!("无法打开系统分享面板，请重试");
    }
    Ok(receiver)
}

pub fn copy_image(bytes: &[u8], html: &str) -> anyhow::Result<()> {
    let html = std::ffi::CString::new(html)?;
    anyhow::ensure!(
        unsafe { cnote_copy_image(bytes.as_ptr(), bytes.len(), html.as_ptr()) } != 0,
        "无法解码图片或写入系统剪贴板"
    );
    Ok(())
}

/// Download off the UI thread. Both embedded images and HTTPS images use the same clipboard path.
pub fn image_bytes(source: &str) -> anyhow::Result<Vec<u8>> {
    use base64::Engine;
    use std::io::Read;
    const LIMIT: usize = 20 * 1024 * 1024;
    if source.starts_with("data:image/") {
        let (header, data) = source
            .split_once(',')
            .ok_or_else(|| anyhow::anyhow!("图片数据格式错误"))?;
        anyhow::ensure!(
            header.ends_with(";base64") && data.len() <= LIMIT * 4 / 3 + 4,
            "图片数据格式错误或超过 20 MB"
        );
        let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
        anyhow::ensure!(
            !bytes.is_empty() && bytes.len() <= LIMIT,
            "图片为空或超过 20 MB"
        );
        return Ok(bytes);
    }
    let url = url::Url::parse(source)?;
    anyhow::ensure!(url.scheme() == "https", "图片地址必须使用 HTTPS");
    let response = reqwest::blocking::Client::builder()
        .https_only(true)
        .timeout(std::time::Duration::from_secs(20))
        .build()?
        .get(url)
        .send()?
        .error_for_status()?;
    let mut bytes = Vec::new();
    response.take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        !bytes.is_empty() && bytes.len() <= LIMIT,
        "图片为空或超过 20 MB"
    );
    Ok(bytes)
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
/// Schedule a native popup outside GPUI’s update to allow menu action dispatch.
pub fn show_more_menu() {
    unsafe { cnote_workspace_show_more_menu() };
}

pub fn test_more_menu() {
    unsafe { cnote_workspace_test_more_menu() };
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
            "ace.edit('tool-text-editor').setValue('{\"id\":9007199254740993123}',-1);document.getElementById('text-preview').click();",
            "(()=>{const apply=document.getElementById('text-apply');if(!apply.disabled)apply.click();return cnoteTools.state.text.includes('\\n')&&cnoteTools.state.text.includes('9007199254740993123');})()",
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
        Workspace::Trello => (
            "window.cnoteTrello",
            "",
            "!document.getElementById('trello-tool').hidden",
        ),
        Workspace::Notes => return String::new(),
    };
    format!(
        r#"(()=>{{let attempts=0;const fail=message=>window.ipc.postMessage(JSON.stringify({{type:'native_tool_smoke',index:{index},error:String(message)}}));const done=()=>window.ipc.postMessage(JSON.stringify({{type:'native_tool_smoke',index:{index}}}));function wait(){{try{{if(!window.cnoteTools||!({ready})){{if(++attempts<200)return setTimeout(wait,25);throw Error('工具初始化超时');}}{action}attempts=0;function poll(){{if({result})return done();if(++attempts<200)return setTimeout(poll,25);fail(document.getElementById('tool-status').textContent);}}poll();}}catch(e){{fail(e.message);}}}}wait();}})();"#,
        index = page.index()
    )
}
