//! Durable publication of automatic reviews using the tablet's v1 comment protocol.
use super::*;
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Review {
    review_id: String,
    result: Value,
    comment_attempted: bool,
    comment_id: Option<String>,
    list_attempted: bool,
    done: bool,
}
struct Store {
    path: PathBuf,
    _lock: File,
}
impl Store {
    fn open(card: &str) -> Result<Self> {
        identifier(&json!({"id":card}))?;
        #[cfg(cnote_shared_core)]
        let dir = crate::platform::data()?.join("homework-reviews");
        #[cfg(not(cnote_shared_core))]
        let dirs = directories::ProjectDirs::from("com", "cyeam", "CNote")
            .context("找不到批改结果目录")?;
        #[cfg(not(cnote_shared_core))]
        let dir = dirs.data_dir().join("homework-reviews");
        std::fs::create_dir_all(&dir)?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(dir.join(format!("{card}.lock")))?;
        lock.try_lock()
            .context("此卡片正在阅卷或提交，请稍后重试")?;
        Ok(Self {
            path: dir.join(format!("{card}.json")),
            _lock: lock,
        })
    }
    fn load(&self) -> Result<Option<Review>> {
        load(&self.path)
    }
    fn save(&self, review: &Review) -> Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())?;
        file.write_all(&serde_json::to_vec(review)?)?;
        file.as_file().sync_all()?;
        file.persist(&self.path)
            .map_err(|_| anyhow::anyhow!("保存批改结果失败"))?;
        Ok(())
    }
}
fn load(path: &Path) -> Result<Option<Review>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(
            serde_json::from_slice(&bytes).context("本地批改记录损坏，请检查后重试")?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn grade(result: &Value) -> Result<&str> {
    let grade = result["report"]["grade"].as_str().unwrap_or_default();
    anyhow::ensure!(
        ["", "100", "优", "良", "中", "差"].contains(&grade),
        "服务返回无效评分，未提交"
    );
    anyhow::ensure!(
        grade != "100" || result["report"]["provisional"] != true,
        "暂评不能提交为100"
    );
    Ok(grade)
}
fn yaml_word(value: &str) -> String {
    let value = value.trim();
    if value.starts_with(|c: char| c.is_ascii_alphabetic())
        && value
            .chars()
            .all(|c| c.is_ascii_alphabetic() || " '-".contains(c))
        && !["null", "true", "false", "yes", "no", "on", "off"]
            .contains(&value.to_ascii_lowercase().as_str())
    {
        value.to_owned()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
    }
}
fn dictation_pair(input: &Value, item: &Value) -> Result<String> {
    let index = item["number"]
        .as_u64()
        .and_then(|n| n.checked_sub(1))
        .and_then(|n| usize::try_from(n).ok())
        .context("听写题号缺失，未提交错词记录")?;
    let word = input["words"]
        .as_array()
        .and_then(|words| words.get(index))
        .and_then(Value::as_str)
        .filter(|word| !word.trim().is_empty())
        .context("听写原词缺失，未提交错词记录")?;
    let raw = if item["state"] == "blank" {
        "[未作答]"
    } else {
        item["raw"]
            .as_str()
            .filter(|raw| !raw.trim().is_empty())
            .unwrap_or("[未识别]")
    };
    Ok(format!("{}: {}", yaml_word(raw), yaml_word(word)))
}
fn comment(review: &Review) -> Result<String> {
    let report = &review.result["report"];
    let grade = grade(&review.result)?;
    let provisional = report["provisional"] == true;
    let mut lines = Vec::new();
    if review.result["input"]["kind"] == "reading" {
        let feedback = report["feedback"]
            .as_str()
            .filter(|feedback| !feedback.trim().is_empty())
            .context("阅读服务未返回完整反馈，结果已保留，未提交不完整的批改")?;
        lines.push(feedback.to_owned());
    } else {
        if grade.is_empty() {
            lines.push("暂无可判定评分，请先核对作业内容。".to_owned());
        }
        lines.push(format!(
            "正确 {} · 需订正 {} · 待核对 {} / 共 {} 项",
            report["correct"], report["incorrect"], report["pending"], report["total"]
        ));
        let dictation = review.result["input"]["kind"] == "dictation";
        for (status, heading) in [("incorrect", "需订正"), ("pending", "待核对")] {
            let items: Vec<_> = report["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["status"] == status)
                .collect();
            if items.is_empty() {
                continue;
            }
            lines.push(format!("{heading}："));
            for item in items {
                if dictation {
                    lines.push(dictation_pair(&review.result["input"], item)?);
                    continue;
                }
                let raw = item["raw"].as_str().unwrap_or_default().trim();
                let expression = item["expression"].as_str().unwrap_or_default().trim();
                let observed = if item["state"] == "blank" {
                    "未作答".to_owned()
                } else if raw.is_empty() {
                    "字迹不清，未能确认".to_owned()
                } else if expression.is_empty() {
                    format!("识别为「{raw}」")
                } else {
                    format!("识别为「{expression} = {raw}」")
                };
                lines.push(format!("第{}题：{}。", item["number"], observed));
                if let Some(hint) = item["hint"].as_str().filter(|hint| !hint.trim().is_empty()) {
                    lines.push(format!("提示：{hint}"));
                }
            }
        }
        if provisional {
            lines.push("含待核对项目，当前评分为暂评。".to_owned());
        }
    }
    let mut payload =
        json!({"version":1,"type":"text","review_id":review.review_id,"text":lines.join("\n")});
    if !grade.is_empty() {
        payload["grade"] = json!(grade);
        payload["provisional"] = json!(provisional);
        payload["has_errors"] = json!(grade != "100");
    }
    Ok(format!("作业批改：\n{}", serde_json::to_string(&payload)?))
}
fn publish(
    review: &mut Review,
    card: &str,
    mut call: impl FnMut(&str, &str, Option<&Value>) -> Result<Value>,
    mut save: impl FnMut(&Review) -> Result<()>,
) -> Result<Option<Value>> {
    if review.done {
        return Ok(None);
    }
    let grade = grade(&review.result)?.to_owned();
    if review.comment_id.is_none() {
        if review.comment_attempted {
            let mut before = String::new();
            loop {
                let page = call(
                    "GET",
                    &format!("/cards/{card}/actions?filter=commentCard&limit=1000{before}"),
                    None,
                )?;
                let actions = page.as_array().context("读取批改历史失败")?;
                for action in actions {
                    let matched = action["data"]["text"]
                        .as_str()
                        .and_then(|text| text.strip_prefix("作业批改："))
                        .and_then(|text| serde_json::from_str::<Value>(text.trim()).ok())
                        .is_some_and(|value| value["review_id"] == review.review_id);
                    if matched {
                        review.comment_id =
                            Some(action["id"].as_str().context("批改评论ID缺失")?.to_owned());
                        break;
                    }
                }
                if review.comment_id.is_some() || actions.len() < 1000 {
                    break;
                }
                let id = actions
                    .last()
                    .and_then(|a| a["id"].as_str())
                    .context("批改历史分页ID缺失")?;
                identifier(&json!({"id":id}))?;
                before = format!("&before={id}");
            }
            anyhow::ensure!(
                review.comment_id.is_some(),
                "上次评论提交结果未知，尚未查到记录；请稍后重试核对，未重复发布"
            );
            save(review)?;
        } else {
            let text = comment(review)?;
            review.comment_attempted = true;
            save(review)?;
            let action = match call(
                "POST",
                &format!("/cards/{card}/actions/comments"),
                Some(&json!({"text":text})),
            ) {
                Ok(action) => action,
                Err(error) => {
                    if error.is::<WriteRejected>() {
                        review.comment_attempted = false;
                        save(review)?;
                    }
                    return Err(error);
                }
            };
            review.comment_id = Some(action["id"].as_str().context("批改评论ID缺失")?.to_owned());
            save(review)?;
        }
    }
    let updated = if grade.is_empty() {
        None
    } else {
        let current = call(
            "GET",
            &format!("/cards/{card}?fields=desc,idBoard,idList"),
            None,
        )?;
        let board = identifier(&json!({"id":current["idBoard"]}))?.to_owned();
        let lists = call(
            "GET",
            &format!("/boards/{board}/lists?filter=open&fields=name"),
            None,
        )?;
        let lists = lists.as_array().context("读取看板列表失败")?;
        let corrected = lists
            .iter()
            .any(|l| l["id"] == current["idList"] && l["name"] == "已改错");
        let target = if grade == "100" {
            if corrected { "已改错" } else { "已完成" }
        } else {
            "待改错"
        };
        let list = if let Some(list) = lists
            .iter()
            .find(|l| l["name"].as_str().is_some_and(|s| s.trim() == target))
        {
            list.clone()
        } else {
            anyhow::ensure!(
                !review.list_attempted,
                "上次创建状态列表结果未知，请稍后重试核对"
            );
            review.list_attempted = true;
            save(review)?;
            match call(
                "POST",
                "/lists",
                Some(&json!({"name":target,"idBoard":board})),
            ) {
                Ok(list) => list,
                Err(error) => {
                    if error.is::<WriteRejected>() {
                        review.list_attempted = false;
                        save(review)?;
                    }
                    return Err(error);
                }
            }
        };
        let list = identifier(&json!({"id":list["id"]}))?.to_owned();
        let mut desc =
            description_with_grade(current["desc"].as_str().unwrap_or_default(), &grade)?;
        if review.result["report"]["provisional"] == true {
            desc = desc.replacen(
                &format!("打分结果：{grade}"),
                &format!("打分结果：暂评·{grade}"),
                1,
            );
        }
        Some(call(
            "PUT",
            &format!("/cards/{card}"),
            Some(&json!({"desc":desc,"idList":list,"dueComplete":grade=="100"})),
        )?)
    };
    review.done = true;
    save(review)?;
    Ok(updated)
}
fn run(api: &Api, card: &str, store: &Store, review: &mut Review) -> Value {
    let publication = publish(
        review,
        card,
        |method, path, body| {
            api.send_url(
                reqwest::Method::from_bytes(method.as_bytes())?,
                &format!("{API}{path}"),
                &[],
                body,
            )
        },
        |review| store.save(review),
    );
    let mut result = review.result.clone();
    result["review_id"] = json!(review.review_id);
    match publication {
        Ok(updated) => {
            result["published"] = json!(true);
            if let Some(card) = updated {
                result["card"] = card;
            }
        }
        Err(error) => {
            result["published"] = json!(false);
            result["publication_error"] = json!(error.to_string());
        }
    }
    result
}
pub(super) fn review(api: &Api, v: &Value) -> Result<Value> {
    let card = identifier(v)?;
    let store = Store::open(card)?;
    if let Some(mut pending) = store.load()?.filter(|r| !r.done) {
        return Ok(run(api, card, &store, &mut pending));
    }
    let ids = match v.get("attachments") {
        Some(value) => value.as_array().context("无效的附件列表")?.clone(),
        None => vec![v["attachment"].clone()],
    };
    let reading = v["kind"] == "reading";
    anyhow::ensure!(
        !ids.is_empty() && ids.len() <= if reading { 1 } else { 2 },
        "请提交1至2张作业图片或一段录音"
    );
    let mut uploads = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        anyhow::ensure!(!ids[..index].contains(id), "附件重复，请重新打开卡片");
        let id = identifier(&json!({"id":id}))?.to_owned();
        let data = api.attachment(card, &id, true)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data["base64"].as_str().context("附件数据缺失")?)?;
        uploads.push((
            bytes,
            data["mime"].as_str().context("附件格式缺失")?.to_owned(),
        ));
    }
    let mut result = if reading {
        let (bytes, mime) = uploads.pop().unwrap();
        crate::homework::review(v, bytes, &mime)?
    } else {
        crate::homework::review_images(v, uploads)?
    };
    result["source_attachment"] = ids[0].clone();
    result["source_attachments"] = json!(ids);
    let mut review = Review {
        review_id: uuid::Uuid::new_v4().to_string(),
        result,
        comment_attempted: false,
        comment_id: None,
        list_attempted: false,
        done: false,
    };
    store.save(&review)?;
    Ok(run(api, card, &store, &mut review))
}
pub(super) fn retry(api: &Api, v: &Value) -> Result<Value> {
    let card = identifier(v)?;
    let store = Store::open(card)?;
    let mut review = store.load()?.context("没有待提交的批改结果")?;
    anyhow::ensure!(
        v["review_id"] == review.review_id,
        "批改记录已更新，请重新打开卡片"
    );
    Ok(run(api, card, &store, &mut review))
}
pub(super) fn latest(card: &str) -> Result<Option<Value>> {
    let store = Store::open(card)?;
    Ok(store.load()?.map(|review| {
        let mut result = review.result;
        result["review_id"] = json!(review.review_id);
        result["published"] = json!(review.done);
        result
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    const CARD: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const BOARD: &str = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const DONE: &str = "cccccccccccccccccccccccc";
    const CORRECTED: &str = "dddddddddddddddddddddddd";
    const FIX: &str = "eeeeeeeeeeeeeeeeeeeeeeee";
    fn review(grade: &str) -> Review {
        Review {
            review_id: uuid::Uuid::new_v4().to_string(),
            result: json!({"input":{"kind":"arithmetic"},"report":{"grade":grade,"correct":9,"incorrect":1,"pending":0,"total":10,"items":[{"number":3,"status":"incorrect","hint":"请重新计算","raw":"wrong","answer":"secret answer"}]}}),
            comment_attempted: false,
            comment_id: None,
            list_attempted: false,
            done: false,
        }
    }
    fn current(list: &str) -> Value {
        json!({"id":CARD,"idBoard":BOARD,"idList":list,"desc":"打分结果：差\n作业类型：口算\n原题保留"})
    }
    fn lists() -> Value {
        json!([{"id":DONE,"name":"已完成"},{"id":CORRECTED,"name":"已改错"},{"id":FIX,"name":"待改错"}])
    }
    #[test]
    fn all_grades_publish_comment_grade_and_requested_status() {
        for grade in ["100", "优", "良", "中", "差"] {
            for original in [DONE, CORRECTED] {
                let mut review = review(grade);
                let mut posted = 0;
                let mut updated = 0;
                let response = publish(
                    &mut review,
                    CARD,
                    |method, path, body| match method {
                        "POST" => {
                            assert!(path.ends_with("/actions/comments"));
                            posted += 1;
                            let text = body.unwrap()["text"].as_str().unwrap();
                            assert!(!text.contains("secret answer"));
                            let payload: Value =
                                serde_json::from_str(text.strip_prefix("作业批改：\n").unwrap())
                                    .unwrap();
                            assert_eq!(payload["version"], 1);
                            assert_eq!(payload["grade"], grade);
                            assert_eq!(payload["has_errors"], grade != "100");
                            Ok(json!({"id":"action"}))
                        }
                        "GET" if path.starts_with("/cards/") => Ok(current(original)),
                        "GET" => Ok(lists()),
                        "PUT" => {
                            updated += 1;
                            let body = body.unwrap();
                            assert_eq!(body["idList"], if grade == "100" { original } else { FIX });
                            assert_eq!(body["dueComplete"], grade == "100");
                            assert_eq!(
                                body["desc"],
                                format!("打分结果：{grade}\n作业类型：口算\n原题保留")
                            );
                            Ok(body.clone())
                        }
                        _ => panic!("unexpected request"),
                    },
                    |_| Ok(()),
                )
                .unwrap();
                assert!(response.is_some());
                assert!(review.done);
                assert_eq!((posted, updated), (1, 1));
                assert!(
                    publish(
                        &mut review,
                        CARD,
                        |_, _, _| panic!("completed review must not replay"),
                        |_| Ok(())
                    )
                    .unwrap()
                    .is_none()
                );
            }
        }
    }
    #[test]
    fn tablet_text_summarizes_correct_items_and_keeps_recognition_for_corrections() {
        let mut review = review("中");
        review.result["input"]["words"] = json!(["secret reference word"]);
        review.result["report"]["items"] = json!([
            {"number":1,"status":"correct","raw":"student answer"},
            {"number":2,"status":"incorrect","raw":"e-reder","hint":"请重新听写"},
            {"number":3,"status":"pending","raw":"unclear","hint":"请核对字迹"}
        ]);
        let comment = comment(&review).unwrap();
        let payload: Value =
            serde_json::from_str(comment.strip_prefix("作业批改：\n").unwrap()).unwrap();
        assert_eq!(payload["version"], 1);
        assert_eq!(payload["type"], "text");
        assert!(!payload.as_object().unwrap().contains_key("attachment_id"));
        let text = payload["text"].as_str().unwrap();
        assert!(!text.contains("第1题"));
        assert!(text.contains("第2题：识别为「e-reder」"));
        assert!(text.contains("待核对："));
        assert!(text.contains("第3题：识别为「unclear」"));
        assert!(!text.contains("secret reference word"));
        assert!(!text.contains("review_id"));
    }
    #[test]
    fn dictation_records_observed_to_reference_pairs_and_separates_pending() {
        let mut review = review("差");
        review.result["input"] =
            json!({"kind":"dictation","words":["hungry","ice cream","lemonade","menu"]});
        review.result["report"]["items"] = json!([
            {"number":1,"status":"pending","raw":"e-reder game console gps","state":"uncertain"},
            {"number":2,"status":"correct","raw":"ice cream","state":"clear"},
            {"number":3,"status":"incorrect","raw":"temud","state":"clear"},
            {"number":4,"status":"incorrect","raw":"","state":"blank"}
        ]);
        let payload: Value = serde_json::from_str(
            comment(&review)
                .unwrap()
                .strip_prefix("作业批改：\n")
                .unwrap(),
        )
        .unwrap();
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("需订正：\ntemud: lemonade\n\"[未作答]\": menu"));
        assert!(text.contains("待核对：\ne-reder game console gps: hungry"));
        assert!(!text.contains("ice cream: ice cream"));
        assert!(!text.contains("第3项"));
        let item = json!({"number":3,"raw":"a:\nb","state":"clear"});
        assert_eq!(
            dictation_pair(&review.result["input"], &item).unwrap(),
            "\"a:\\nb\": lemonade"
        );
        assert!(dictation_pair(&json!({"words":[]}), &item).is_err());
    }
    #[test]
    fn reading_keeps_the_service_feedback_verbatim_including_links() {
        let mut review = review("良");
        let feedback = "阅读等级：良。\n阅读参考分：72.0%。\n\n重点词重读：https://www.cyeam.com/ai/translate?words=example\n逐词听发音并跟读3遍。\n";
        review.result["input"] = json!({"kind":"reading"});
        review.result["report"] = json!({"grade":"良","feedback":feedback});
        let payload: Value = serde_json::from_str(
            comment(&review)
                .unwrap()
                .strip_prefix("作业批改：\n")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["text"], feedback);
        review.result["report"]["feedback"] = json!("");
        assert!(
            comment(&review)
                .unwrap_err()
                .to_string()
                .contains("未返回完整反馈")
        );
    }
    #[test]
    fn arithmetic_keeps_recognized_expression_answer_and_server_hint() {
        let mut review = review("良");
        review.result["report"]["items"] = json!([
            {"number":1,"status":"correct","expression":"1+1","raw":"2","hint":"正确"},
            {"number":2,"status":"incorrect","expression":"26+17","raw":"42","hint":"请检查进位"},
            {"number":3,"status":"pending","expression":"8*3","raw":"?","state":"uncertain","hint":"请核对原图字迹"}
        ]);
        let payload: Value = serde_json::from_str(
            comment(&review)
                .unwrap()
                .strip_prefix("作业批改：\n")
                .unwrap(),
        )
        .unwrap();
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("识别为「26+17 = 42」"));
        assert!(text.contains("提示：请检查进位"));
        assert!(text.contains("提示：请核对原图字迹"));
        assert!(!text.contains("1+1"));
    }
    #[test]
    fn status_failure_retries_without_duplicate_comment() {
        let mut review = review("良");
        let mut posts = 0;
        let mut puts = 0;
        let mut backend = |method: &str, path: &str, _body: Option<&Value>| -> Result<Value> {
            match method {
                "POST" => {
                    posts += 1;
                    Ok(json!({"id":"action"}))
                }
                "GET" if path.starts_with("/cards/") => Ok(current(DONE)),
                "GET" => Ok(lists()),
                "PUT" => {
                    puts += 1;
                    if puts == 1 {
                        bail!("network")
                    }
                    Ok(json!({"id":CARD}))
                }
                _ => panic!(),
            }
        };
        assert!(publish(&mut review, CARD, &mut backend, |_| Ok(())).is_err());
        let mut restarted: Review =
            serde_json::from_slice(&serde_json::to_vec(&review).unwrap()).unwrap();
        publish(&mut restarted, CARD, &mut backend, |_| Ok(())).unwrap();
        assert!(restarted.done);
        assert_eq!((posts, puts), (1, 2));
    }
    #[test]
    fn lost_comment_response_recovers_by_review_id_and_stops_if_unknown() {
        let mut review = review("优");
        let text = comment(&review).unwrap();
        let mut posts = 0;
        assert!(
            publish(
                &mut review,
                CARD,
                |_, _, _| {
                    posts += 1;
                    bail!("lost response")
                },
                |_| Ok(())
            )
            .is_err()
        );
        assert!(review.comment_attempted);
        let error = publish(
            &mut review,
            CARD,
            |method, _, _| {
                assert_eq!(method, "GET");
                Ok(json!([]))
            },
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("未重复发布"));
        publish(
            &mut review,
            CARD,
            |method, path, _| match method {
                "GET" if path.contains("/actions?") => {
                    Ok(json!([{"id":"action","data":{"text":text}}]))
                }
                "GET" if path.starts_with("/cards/") => Ok(current(DONE)),
                "GET" => Ok(lists()),
                "PUT" => Ok(json!({"id":CARD})),
                _ => panic!("must not POST twice"),
            },
            |_| Ok(()),
        )
        .unwrap();
        assert!(review.done);
        assert_eq!(posts, 1);
    }
    #[test]
    fn provisional_is_preserved_and_ungraded_does_not_move() {
        let mut review = review("优");
        review.result["report"]["provisional"] = json!(true);
        publish(
            &mut review,
            CARD,
            |method, path, body| match method {
                "POST" => Ok(json!({"id":"action"})),
                "GET" if path.starts_with("/cards/") => Ok(current(DONE)),
                "GET" => Ok(lists()),
                "PUT" => {
                    assert!(
                        body.unwrap()["desc"]
                            .as_str()
                            .unwrap()
                            .starts_with("打分结果：暂评·优")
                    );
                    assert_eq!(body.unwrap()["idList"], FIX);
                    Ok(json!({}))
                }
                _ => panic!(),
            },
            |_| Ok(()),
        )
        .unwrap();
        let mut ungraded = super::tests::review("");
        publish(
            &mut ungraded,
            CARD,
            |method, _, body| {
                assert_eq!(method, "POST");
                assert!(
                    !body.unwrap()["text"]
                        .as_str()
                        .unwrap()
                        .contains("has_errors")
                );
                Ok(json!({"id":"action"}))
            },
            |_| Ok(()),
        )
        .unwrap();
        assert!(ungraded.done);
    }
    #[test]
    fn saved_review_survives_restart_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store {
            path: dir.path().join("review.json"),
            _lock: tempfile::tempfile().unwrap(),
        };
        assert!(store.load().unwrap().is_none());
        let mut review = review("中");
        review.comment_id = Some("posted".into());
        review.comment_attempted = true;
        store.save(&review).unwrap();
        let restored = store.load().unwrap().unwrap();
        assert_eq!(restored.review_id, review.review_id);
        assert_eq!(restored.comment_id, Some("posted".into()));
        assert!(!restored.done);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&store.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn missing_list_created_on_same_board() {
        let mut review = review("差");
        let mut created = false;
        publish(
            &mut review,
            CARD,
            |method, path, body| match (method, path) {
                ("POST", "/lists") => {
                    created = true;
                    assert_eq!(body.unwrap(), &json!({"idBoard":BOARD,"name":"待改错"}));
                    Ok(json!({"id":FIX}))
                }
                ("POST", _) => Ok(json!({"id":"action"})),
                ("GET", p) if p.starts_with("/cards/") => Ok(current(DONE)),
                ("GET", _) => Ok(json!([])),
                ("PUT", _) => Ok(json!({})),
                _ => panic!(),
            },
            |_| Ok(()),
        )
        .unwrap();
        assert!(created);
    }
}
