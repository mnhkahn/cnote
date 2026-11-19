//! Microsoft-authenticated connection storage; tokens never pass through the WebView.
use super::*;
use serde_json::{Value, json};
use std::fmt;

const ENDPOINT: &str = "https://www.cyeam.com/api/cnote/trello-connection";
#[derive(Debug)]
struct ConnectionError {
    code: String,
    message: String,
}
impl fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ConnectionError {}
pub(super) fn error_code(error: &anyhow::Error) -> &str {
    error
        .downcast_ref::<ConnectionError>()
        .map(|e| e.code.as_str())
        .unwrap_or_else(|| crate::trello::error_code(error))
}
impl Cloud {
    fn connection_api(
        &mut self,
        method: reqwest::Method,
        version: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let token = self.token()?;
        // Android supplies its TLS verifier through the shared HTTP factory.
        let client = crate::http::client()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .build()?;
        let mut request = client
            .request(method.clone(), ENDPOINT)
            .bearer_auth(token)
            .header("Accept", "application/json");
        if method != reqwest::Method::GET {
            request = if version.is_empty() {
                request.header("If-None-Match", "*")
            } else {
                request.header("If-Match", format!("\"{version}\""))
            };
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .map_err(|_| anyhow::anyhow!("作业账号同步服务暂时无法连接，本机授权仍保留"))?;
        let status = response.status();
        let value: Value = serde_json::from_reader(std::io::Read::take(response, 32 * 1024))
            .map_err(|_| anyhow::anyhow!("作业账号同步服务尚不可用"))?;
        if !status.is_success() {
            let code = value["code"].as_str().unwrap_or("connection_unavailable");
            let message = match code {
                "auth_required" => "Trello 授权已失效，请重新授权",
                "microsoft_auth_required" => "微软登录已失效，请重新登录",
                "connection_changed" => "作业连接已在其他设备更新，请刷新后重试",
                "board_unavailable" => "当前授权无法访问这个作业看板",
                _ => "作业账号同步服务暂不可用，本机授权仍保留",
            };
            return Err(ConnectionError {
                code: code.into(),
                message: message.into(),
            }
            .into());
        }
        Ok(value)
    }
    pub(super) fn trello_connection(&mut self, v: &Value) -> Result<Value> {
        let account = crate::trello::connection_account()?;
        anyhow::ensure!(
            !account.is_empty() && v["account_id"].as_str() == Some(account.as_str()),
            "微软账号已切换，请重试"
        );
        match v["op"].as_str().unwrap_or_default() {
            "status" => {
                let (pending, _) = crate::trello::connection_sync_state(&account)?;
                let remote = match self.connection_api(reqwest::Method::GET, "", None) {
                    Ok(remote) => remote,
                    Err(error) => {
                        let mut local = crate::trello::request(v.clone())?;
                        local["cloud_available"] = json!(false);
                        local["connection_error"] = json!(error.to_string());
                        return Ok(local);
                    }
                };
                anyhow::ensure!(
                    remote["connected"].is_boolean(),
                    "作业连接响应格式无效，本机授权仍保留"
                );
                let connected = remote["connected"] == true;
                crate::trello::connection_revision(
                    &account,
                    remote["revision"].as_str().unwrap_or_default(),
                )?;
                if connected && !pending {
                    crate::trello::restore_connection(
                        &account,
                        remote["revision"].as_str().context("作业连接版本缺失")?,
                        remote["connection"].clone(),
                    )?;
                } else if !pending {
                    crate::trello::clear_missing_connection(&account)?;
                }
                let mut local = crate::trello::request(v.clone())?;
                local["linked"] = json!(connected && !pending);
                local["cloud_available"] = json!(true);
                Ok(local)
            }
            "link_status" => crate::trello::request(v.clone()),
            "link_account" | "link_board" => {
                let (_, expected) = crate::trello::connection_sync_state(&account)?;
                let result = crate::trello::request(v.clone())?;
                let (_, record) =
                    crate::trello::connection_snapshot(&account)?.context("作业连接未保存")?;
                let remote = self.connection_api(reqwest::Method::PUT, &expected, Some(&record))?;
                crate::trello::restore_connection(
                    &account,
                    remote["revision"].as_str().context("作业连接版本缺失")?,
                    remote["connection"].clone(),
                )?;
                Ok(result)
            }
            "disconnect" => {
                let (_, expected) = crate::trello::connection_sync_state(&account)?;
                self.connection_api(reqwest::Method::DELETE, &expected, None)?;
                crate::trello::request(v.clone())
            }
            _ => bail!("未知的作业账号同步操作"),
        }
    }
}
