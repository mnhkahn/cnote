//! Anonymous, best-effort usage events delivered by the official PostHog SDK.
use posthog_rs::{Client, ClientOptionsBuilder};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

// Public ingestion token shared with cyeam-cli; never use a personal API key here.
const PROJECT_TOKEN: &str = "phc_kBqNf6Fx4wEaDzDthoJBqvbVVRCVZZ5Pk8CbeZK49RBp";
const CAPACITY: usize = 128;
struct Tracker {
    client: Client,
    id: String,
}
static TRACKER: OnceLock<Tracker> = OnceLock::new();

pub enum Event {
    Started,
    NoteCreated,
    NoteDeleted,
    Cloud {
        operation: Operation,
        outcome: Outcome,
        duration_ms: u64,
    },
}
#[derive(Clone, Copy)]
pub enum Operation {
    Restore,
    Login,
    Logout,
    List,
    Download,
    Upload,
    Delete,
}
#[derive(Clone, Copy)]
pub enum Outcome {
    Success,
    Failure,
    Conflict,
    LoggedOut,
}
fn truthy(value: &str) -> bool {
    matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes")
}
fn disabled() -> bool {
    cfg!(test)
        || [
            "CNOTE_NO_ANALYTICS",
            "DO_NOT_TRACK",
            "CI",
            "CNOTE_SMOKE_TEST",
        ]
        .iter()
        .any(|key| std::env::var(key).is_ok_and(|v| truthy(&v)))
        || (cfg!(debug_assertions)
            && !std::env::var("CNOTE_ANALYTICS_DEBUG").is_ok_and(|v| truthy(&v)))
}

fn client_options() -> ClientOptionsBuilder {
    let mut options = ClientOptionsBuilder::default();
    options
        .api_key(PROJECT_TOKEN.to_owned())
        .is_server(false)
        .max_queue_size(CAPACITY)
        .on_error(|_| eprintln!("CNote: anonymous usage upload failed"));
    options
}

pub fn start(directory: PathBuf) {
    if disabled() {
        return;
    }
    TRACKER.get_or_init(|| {
        let tracker = Tracker {
            client: posthog_rs::client(client_options().build().expect("valid PostHog options")),
            id: installation_id(&directory),
        };
        tracker
            .client
            .capture(sdk_event(&tracker.id, &Event::Started));
        tracker
    });
}
pub fn capture(event: Event) {
    if let Some(tracker) = TRACKER.get() {
        // The SDK queues and sends on its own bounded background worker.
        tracker.client.capture(sdk_event(&tracker.id, &event));
    }
}
pub fn shutdown() {
    if let Some(tracker) = TRACKER.get() {
        // Called after the UI exits. Let the SDK drain with its default policy.
        tracker.client.shutdown();
    }
}
fn sdk_event(id: &str, event: &Event) -> posthog_rs::Event {
    let mut props = json!({
        "app": "cnote", "platform": "macos",
        "app_version": env!("CNOTE_APP_VERSION"), "os": std::env::consts::OS,
        "architecture": std::env::consts::ARCH, "$process_person_profile": false
    });
    let name = match event {
        Event::Started => "app_started",
        Event::NoteCreated => "note_created",
        Event::NoteDeleted => "note_deleted",
        Event::Cloud {
            operation,
            outcome,
            duration_ms,
        } => {
            props["operation"] = json!(match operation {
                Operation::Restore => "restore",
                Operation::Login => "login",
                Operation::Logout => "logout",
                Operation::List => "list",
                Operation::Download => "download",
                Operation::Upload => "upload",
                Operation::Delete => "delete",
            });
            props["outcome"] = json!(match outcome {
                Outcome::Success => "success",
                Outcome::Failure => "failure",
                Outcome::Conflict => "conflict",
                Outcome::LoggedOut => "logged_out",
            });
            props["duration_ms"] = json!(duration_ms);
            match operation {
                Operation::Restore => "session_restored",
                Operation::Login => "login_completed",
                Operation::Logout => "logout_completed",
                _ => "sync_completed",
            }
        }
    };
    let mut event = posthog_rs::Event::new(name, id);
    for (key, value) in props.as_object().expect("event properties are an object") {
        event
            .insert_prop(key, value)
            .expect("JSON values are serializable");
    }
    event
}
fn installation_id(directory: &Path) -> String {
    let path = directory.join("analytics-id");
    let read = || {
        std::fs::read_to_string(&path)
            .ok()
            .filter(|v| uuid::Uuid::parse_str(v).is_ok())
    };
    if let Some(id) = read() {
        return format!("cnote:{id}");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let temp = directory.join(format!(".analytics-{}", uuid::Uuid::new_v4()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(id.as_bytes())?;
        // Atomic publication: concurrent starts read the same complete ID.
        std::fs::hard_link(&temp, &path)?;
        Ok(())
    };
    let _ = write();
    let _ = std::fs::remove_file(temp);
    format!("cnote:{}", read().unwrap_or(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_is_stable_private_and_separate() {
        let dir = tempfile::tempdir().unwrap();
        let a = installation_id(dir.path());
        assert!(a.starts_with("cnote:"));
        assert_eq!(a, installation_id(dir.path()));
        assert_ne!(a, installation_id(tempfile::tempdir().unwrap().path()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.path().join("analytics-id"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn concurrent_starts_publish_one_complete_id() {
        let dir = tempfile::tempdir().unwrap();
        let ids = std::thread::scope(|s| {
            let threads: Vec<_> = (0..12)
                .map(|_| s.spawn(|| installation_id(dir.path())))
                .collect();
            threads
                .into_iter()
                .map(|t| t.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(ids.iter().all(|id| id == &ids[0]));
    }
    #[test]
    fn tests_never_initialize_or_send_telemetry() {
        assert!(disabled());
        start(PathBuf::from("/unused/test-data"));
        assert!(TRACKER.get().is_none());
    }
    #[test]
    fn events_keep_anonymous_identity_and_only_allowlisted_app_properties() {
        let events = [
            Event::Started,
            Event::NoteCreated,
            Event::NoteDeleted,
            Event::Cloud {
                operation: Operation::Upload,
                outcome: Outcome::Conflict,
                duration_ms: 42,
            },
        ];
        for (event, name) in events.iter().zip([
            "app_started",
            "note_created",
            "note_deleted",
            "sync_completed",
        ]) {
            let event = sdk_event("cnote:test", event);
            assert_eq!(event.event_name(), name);
            assert_eq!(event.distinct_id(), "cnote:test");
            let props = event.properties();
            assert_eq!(props["app"], "cnote");
            assert_eq!(props["platform"], "macos");
            assert_eq!(props["app_version"], env!("CNOTE_APP_VERSION"));
            assert_eq!(props["$process_person_profile"], false);
            assert!(props.keys().all(|key| {
                [
                    "app",
                    "platform",
                    "app_version",
                    "os",
                    "architecture",
                    "$process_person_profile",
                    "operation",
                    "outcome",
                    "duration_ms",
                ]
                .contains(&key.as_str())
            }));
        }
        let cloud = sdk_event("cnote:test", &events[3]);
        assert_eq!(cloud.properties()["operation"], "upload");
        assert_eq!(cloud.properties()["outcome"], "conflict");
        assert_eq!(cloud.properties()["duration_ms"], 42);
    }
    #[test]
    fn sdk_capture_drains_to_http_on_shutdown() {
        use std::{
            io::{BufRead, BufReader, Read, Write},
            time::{Duration, Instant},
        };
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let host = format!("http://{}", server.local_addr().unwrap());
        let received = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let stream = loop {
                match server.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "SDK did not send queued event");
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(e) => panic!("accept: {e}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("POST /batch/ "));
            let mut length = None;
            let mut sdk_user_agent = false;
            loop {
                line.clear();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
                sdk_user_agent |= lower.starts_with("user-agent: posthog-rs/");
            }
            assert!(sdk_user_agent);
            let mut bytes = vec![0; length.unwrap()];
            reader.read_exact(&mut bytes).unwrap();
            reader.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"status\":\"Ok\"}").unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        });
        let client = posthog_rs::client(client_options().host(host).build().unwrap());
        client.capture(sdk_event("cnote:local-test", &Event::Started));
        client.shutdown();
        let body = received.join().unwrap();
        assert_eq!(body["api_key"], PROJECT_TOKEN);
        assert_eq!(body["batch"].as_array().unwrap().len(), 1);
        let event = &body["batch"][0];
        assert_eq!(event["distinct_id"], "cnote:local-test");
        assert_eq!(event["event"], "app_started");
        assert_eq!(event["properties"]["app"], "cnote");
        assert_eq!(event["properties"]["$process_person_profile"], false);
        assert_ne!(event["properties"]["$is_server"], true);
        assert_eq!(event["properties"]["$lib"], "posthog-rs");
        assert!(uuid::Uuid::parse_str(event["uuid"].as_str().unwrap()).is_ok());
        assert!(event["timestamp"].is_string());
    }
    #[test]
    #[ignore = "sends a marked diagnostic event to the real PostHog project"]
    fn live_sdk_capture() {
        let failed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = failed.clone();
        let client = posthog_rs::client(
            client_options()
                .on_error(move |_| {
                    flag.store(true, std::sync::atomic::Ordering::SeqCst);
                })
                .build()
                .unwrap(),
        );
        let id = format!("cnote:diagnostic:{}", uuid::Uuid::new_v4());
        let mut event = sdk_event(&id, &Event::Started);
        event.insert_prop("integration_test", true).unwrap();
        event
            .insert_prop("diagnostic", "official-sdk-migration")
            .unwrap();
        println!("PostHog diagnostic ID: {id}");
        client.capture(event);
        client.shutdown();
        assert!(
            !failed.load(std::sync::atomic::Ordering::SeqCst),
            "SDK reported a delivery failure"
        );
    }
}
