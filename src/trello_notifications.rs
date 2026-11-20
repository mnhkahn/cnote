//! Desktop-only polling, independent of web-view visibility and refresh timers.
use super::*;
use std::collections::HashMap;

static BOARD: Mutex<String> = Mutex::new(String::new());
pub fn select_board(board: &str) {
    if let Ok(mut selected) = BOARD.lock() {
        *selected = board.into();
    }
}

unsafe extern "C" {
    fn cnote_notifications_install();
    fn cnote_notifications_prepare();
    fn cnote_notification_send(
        identifier: *const std::ffi::c_char,
        title: *const std::ffi::c_char,
        body: *const std::ffi::c_char,
    );
}

#[derive(Default)]
struct Tracker {
    identity: Option<(String, Credentials, String)>,
    cards: HashMap<String, String>,
}
impl Tracker {
    fn observe(
        &mut self,
        identity: (String, Credentials, String),
        data: &Value,
    ) -> Vec<(String, String, String)> {
        let lists: HashMap<_, _> = data["lists"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|list| Some((list["id"].as_str()?, list["name"].as_str()?)))
            .collect();
        let current: HashMap<String, String> = data["cards"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|card| card["closed"] != true)
            .filter_map(|card| Some((card["id"].as_str()?.into(), card["idList"].as_str()?.into())))
            .collect();
        let mut notifications = Vec::new();
        if self.identity.as_ref() == Some(&identity) {
            for card in data["cards"].as_array().into_iter().flatten() {
                let Some(id) = card["id"].as_str() else {
                    continue;
                };
                let Some(list) = current.get(id) else {
                    continue;
                };
                // Only observed transitions count, never the first sight of a card.
                if self.cards.get(id).is_some_and(|old| old != list) {
                    let status = lists.get(list.as_str()).copied().unwrap_or_default().trim();
                    if matches!(status, "已完成" | "已改错") {
                        notifications.push((
                            id.into(),
                            card["name"].as_str().unwrap_or("作业").into(),
                            status.into(),
                        ));
                    }
                }
            }
        }
        self.identity = Some(identity);
        self.cards = current;
        notifications
    }
}

fn poll(tracker: &mut Tracker) -> Result<()> {
    let (account, auth, board) = {
        let mut session = AUTH
            .lock()
            .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?;
        // Don't provoke a Keychain dialog before the engine restores the account.
        if !session.loaded
            && session.account.is_empty()
            && BOARD.lock().map(|board| board.is_empty()).unwrap_or(true)
        {
            return Ok(());
        }
        let Some(auth) = session.auth()? else {
            *tracker = Tracker::default();
            return Ok(());
        };
        let linked = links()?
            .get(&session.account)
            .map(|link| link.board_id.clone());
        let board =
            linked.unwrap_or_else(|| BOARD.lock().map(|board| board.clone()).unwrap_or_default());
        (session.account.clone(), auth, board)
    };
    if board.is_empty() {
        *tracker = Tracker::default();
        return Ok(());
    }
    identifier(&json!({"id":board}))?;
    let api = Api::new(auth.clone())?;
    let data = json!({
        "lists": api.get(&format!("/boards/{board}/lists"), &[("filter","open"),("fields","name")])?,
        "cards": api.get(&format!("/boards/{board}/cards"), &[("filter","open"),("fields","name,idList,closed")])?,
    });
    anyhow::ensure!(
        data["lists"].is_array() && data["cards"].is_array(),
        "Trello 看板响应格式错误"
    );
    // Discard a response from an account/board disconnected during the request.
    let session = AUTH
        .lock()
        .map_err(|_| anyhow::anyhow!("作业连接状态异常"))?;
    let selected = links()?
        .get(&session.account)
        .map(|link| link.board_id.clone())
        .unwrap_or_else(|| BOARD.lock().map(|board| board.clone()).unwrap_or_default());
    if session.account != account || session.auth.as_ref() != Some(&auth) || selected != board {
        return Ok(());
    }
    if tracker.identity.is_none() {
        unsafe {
            cnote_notifications_prepare();
        }
    }
    for (id, name, status) in tracker.observe((account, auth, board), &data) {
        let title = if status == "已改错" {
            "作业已提交订正"
        } else {
            "作业已完成"
        };
        // Trello titles may contain NUL; sanitize before crossing the FFI boundary.
        let body = std::ffi::CString::new(name.replace('\0', " "))?;
        let title = std::ffi::CString::new(title)?;
        let id = std::ffi::CString::new(format!("homework-{id}"))?;
        unsafe {
            cnote_notification_send(id.as_ptr(), title.as_ptr(), body.as_ptr());
        }
    }
    Ok(())
}

pub fn start() {
    unsafe {
        cnote_notifications_install();
    }
    std::thread::spawn(|| {
        let mut tracker = Tracker::default();
        loop {
            // A transient failure leaves the last successful baseline intact.
            if let Err(error) = poll(&mut tracker) {
                eprintln!("CNote homework notifications: {error}");
            }
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity(account: &str) -> (String, Credentials, String) {
        (
            account.into(),
            Credentials {
                key: "test".into(),
                token: "test".into(),
            },
            "board".into(),
        )
    }
    fn snapshot(status: &str) -> Value {
        json!({"lists":[{"id":"todo","name":"待完成"},{"id":"done","name":"已完成"},{"id":"fix","name":"待改错"},{"id":"corrected","name":"已改错"}],"cards":[{"id":"card","name":"数学口算","idList":status,"closed":false}]})
    }
    #[test]
    fn transitions_notify_once_and_correction_is_separate() {
        let mut tracker = Tracker::default();
        assert!(tracker.observe(identity("a"), &snapshot("todo")).is_empty());
        assert_eq!(
            tracker.observe(identity("a"), &snapshot("done"))[0].2,
            "已完成"
        );
        assert!(tracker.observe(identity("a"), &snapshot("done")).is_empty());
        assert!(tracker.observe(identity("a"), &snapshot("fix")).is_empty());
        assert_eq!(
            tracker.observe(identity("a"), &snapshot("corrected"))[0].2,
            "已改错"
        );
    }
    #[test]
    fn first_load_account_switch_and_new_cards_are_silent() {
        let mut tracker = Tracker::default();
        assert!(tracker.observe(identity("a"), &snapshot("done")).is_empty());
        assert!(
            tracker
                .observe(identity("b"), &snapshot("corrected"))
                .is_empty()
        );
        let mut data = snapshot("corrected");
        data["cards"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"new","name":"英语","idList":"done"}));
        assert!(tracker.observe(identity("b"), &data).is_empty());
        let mut changed = identity("b");
        changed.2 = "other-board".into();
        assert!(tracker.observe(changed, &snapshot("done")).is_empty());
    }
    #[test]
    fn completion_flag_and_archiving_do_not_count_as_submission() {
        let mut tracker = Tracker::default();
        tracker.observe(identity("a"), &snapshot("todo"));
        let mut data = snapshot("todo");
        data["cards"][0]["dueComplete"] = json!(true);
        assert!(tracker.observe(identity("a"), &data).is_empty());
        data = snapshot("done");
        data["cards"][0]["closed"] = json!(true);
        assert!(tracker.observe(identity("a"), &data).is_empty());
    }
}
