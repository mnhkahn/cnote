//! Anonymous, bounded, best-effort PostHog capture. Never accepts user content.
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        OnceLock,
        mpsc::{self, Receiver, SyncSender},
    },
    time::{Duration, Instant},
};

// Public ingestion token shared with cyeam-cli; never use a personal API key here.
const PROJECT_TOKEN: &str = "phc_kBqNf6Fx4wEaDzDthoJBqvbVVRCVZZ5Pk8CbeZK49RBp";
const ENDPOINT: &str = "https://us.i.posthog.com/batch/";
const CAPACITY: usize = 128;
const BATCH_SIZE: usize = 32;
const INTERVAL: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: usize = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
static TRACKER: OnceLock<SyncSender<Message>> = OnceLock::new();

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
enum Message {
    Event(Event),
    Flush(mpsc::Sender<()>),
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

pub fn start(directory: PathBuf) {
    if disabled() {
        return;
    }
    let (tx, rx) = mpsc::sync_channel(CAPACITY);
    if TRACKER.set(tx).is_err() {
        return;
    }
    // Client initialization, installation ID I/O and JSON encoding stay off the UI thread.
    let _ = std::thread::Builder::new()
        .name("cnote-analytics".into())
        .spawn(move || {
            let Ok(client) = reqwest::blocking::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(concat!("CNote/", env!("CNOTE_APP_VERSION")))
                .build()
            else {
                return;
            };
            let id = installation_id(&directory);
            worker(rx, INTERVAL, |events| {
                // Retries stay on this bounded background worker, separate from OneDrive.
                send_batch(&client, ENDPOINT, &id, events);
            });
        });
    capture(Event::Started);
}
pub fn capture(event: Event) {
    if let Some(tx) = TRACKER.get() {
        // Dropping telemetry under pressure is preferable to blocking any app worker.
        let _ = tx.try_send(Message::Event(event));
    }
}
pub fn shutdown() {
    if let Some(tx) = TRACKER.get() {
        let (done, wait) = mpsc::channel();
        if tx.try_send(Message::Flush(done)).is_ok() {
            // Called only after the UI has exited. A slow network never holds exit open.
            let _ = wait.recv_timeout(Duration::from_millis(300));
        }
    }
}
fn worker(rx: Receiver<Message>, interval: Duration, mut send: impl FnMut(&[Event])) {
    let mut events = Vec::with_capacity(BATCH_SIZE);
    let mut deadline = Instant::now() + interval;
    loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Message::Event(event)) => events.push(event),
            Ok(Message::Flush(done)) => {
                if !events.is_empty() {
                    send(&events);
                }
                let _ = done.send(());
                return;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if !events.is_empty() {
                    send(&events);
                }
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if events.len() >= BATCH_SIZE || Instant::now() >= deadline {
            if !events.is_empty() {
                send(&events);
                events.clear();
            }
            deadline = Instant::now() + interval;
        }
    }
}
fn send_batch(client: &reqwest::blocking::Client, endpoint: &str, id: &str, events: &[Event]) {
    // Keep event UUIDs and timestamps stable if the server accepted a request whose
    // response was lost. PostHog can then deduplicate a retried event.
    let body = payload(id, events);
    if !deliver_batch(client, endpoint, &body, RETRY_DELAY) {
        // Never log the request, installation ID, token or raw network error.
        eprintln!("CNote: anonymous usage upload failed; batch dropped");
    }
}
fn deliver_batch(
    client: &reqwest::blocking::Client,
    endpoint: &str,
    body: &Value,
    retry_delay: Duration,
) -> bool {
    for attempt in 0..MAX_ATTEMPTS {
        match client.post(endpoint).json(body).send() {
            Ok(response) if response.status().is_success() => return true,
            Ok(response) => {
                let status = response.status();
                if status != reqwest::StatusCode::TOO_MANY_REQUESTS && !status.is_server_error() {
                    return false;
                }
            }
            Err(_) => {}
        }
        if attempt + 1 < MAX_ATTEMPTS {
            std::thread::sleep(retry_delay * (1 << attempt));
        }
    }
    false
}
fn payload(id: &str, events: &[Event]) -> Value {
    let batch: Vec<_> = events
        .iter()
        .map(|event| {
            let mut props = json!({
                "distinct_id": id, "app": "cnote", "platform": "macos",
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
            json!({"uuid": uuid::Uuid::new_v4().to_string(), "event": name, "timestamp": timestamp(), "properties": props})
        })
        .collect();
    json!({"api_key": PROJECT_TOKEN, "batch": batch})
}
fn timestamp() -> String {
    let now: chrono::DateTime<chrono::Utc> = std::time::SystemTime::now().into();
    now.to_rfc3339()
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
    fn batch_contract_has_only_allowlisted_properties() {
        let body = payload(
            "cnote:test",
            &[
                Event::Started,
                Event::NoteCreated,
                Event::NoteDeleted,
                Event::Cloud {
                    operation: Operation::Upload,
                    outcome: Outcome::Conflict,
                    duration_ms: 42,
                },
            ],
        );
        assert_eq!(body["api_key"], PROJECT_TOKEN);
        let batch = body["batch"].as_array().unwrap();
        assert_eq!(batch.len(), 4);
        for event in batch {
            let props = event["properties"].as_object().unwrap();
            assert_eq!(props["app"], "cnote");
            assert_eq!(props["app_version"], env!("CNOTE_APP_VERSION"));
            assert_eq!(props["distinct_id"], "cnote:test");
            assert_eq!(props["$process_person_profile"], false);
            assert!(props.keys().all(|k| {
                [
                    "distinct_id",
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
                .contains(&k.as_str())
            }));
        }
        assert_eq!(batch[3]["event"], "sync_completed");
        assert_eq!(batch[3]["properties"]["outcome"], "conflict");
    }
    #[test]
    fn idle_partial_batch_is_delivered_and_flush_acknowledged() {
        let (tx, rx) = mpsc::sync_channel(CAPACITY);
        let (sent, delivered) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            worker(rx, Duration::from_millis(20), |events| {
                sent.send(payload("test", events)).unwrap();
            })
        });
        tx.send(Message::Event(Event::Started)).unwrap();
        let body = delivered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(body["batch"][0]["event"], "app_started");
        tx.send(Message::Event(Event::NoteCreated)).unwrap();
        let (done, wait) = mpsc::channel();
        tx.send(Message::Flush(done)).unwrap();
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            delivered.recv().unwrap()["batch"][0]["event"],
            "note_created"
        );
        thread.join().unwrap();
    }
    #[test]
    fn http_capture_delivers_a_valid_posthog_batch() {
        use std::io::{BufRead, BufReader, Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/batch/", server.local_addr().unwrap());
        let received = std::thread::spawn(move || {
            let (stream, _) = server.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("POST /batch/ "));
            let mut length = None;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
            }
            let mut bytes = vec![0; length.unwrap()];
            reader.read_exact(&mut bytes).unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            body
        });
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        send_batch(&client, &address, "cnote:local-test", &[Event::Started]);
        let body = received.join().unwrap();
        assert_eq!(body["api_key"], PROJECT_TOKEN);
        assert_eq!(body["batch"][0]["properties"]["app"], "cnote");
        assert_eq!(
            body["batch"][0]["properties"]["distinct_id"],
            "cnote:local-test"
        );
    }
    #[test]
    fn retries_transient_failures_with_stable_event_identity_and_stops_at_limit() {
        use std::io::{BufRead, BufReader, Read, Write};
        // Zero simulates a connection closing before an HTTP response arrives.
        for (statuses, expected) in [
            (vec![500, 200], true),
            (vec![429, 200], true),
            (vec![0, 200], true),
            (vec![400], false),
            (vec![302], false),
            (vec![503; MAX_ATTEMPTS], false),
        ] {
            let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            server.set_nonblocking(true).unwrap();
            let address = format!("http://{}/batch/", server.local_addr().unwrap());
            let attempts = statuses.len();
            let received = std::thread::spawn(move || {
                let mut bodies = Vec::new();
                for status in statuses {
                    let deadline = Instant::now() + Duration::from_secs(3);
                    let stream = loop {
                        match server.accept() {
                            Ok((stream, _)) => break stream,
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(Instant::now() < deadline, "missing retry");
                                std::thread::sleep(Duration::from_millis(1));
                            }
                            Err(e) => panic!("accept: {e}"),
                        }
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut reader = BufReader::new(stream);
                    let mut length = None;
                    loop {
                        let mut line = String::new();
                        assert!(reader.read_line(&mut line).unwrap() > 0);
                        if line == "\r\n" {
                            break;
                        }
                        if let Some(value) =
                            line.to_ascii_lowercase().strip_prefix("content-length:")
                        {
                            length = Some(value.trim().parse::<usize>().unwrap());
                        }
                    }
                    let mut bytes = vec![0; length.unwrap()];
                    reader.read_exact(&mut bytes).unwrap();
                    bodies.push(serde_json::from_slice::<Value>(&bytes).unwrap());
                    if status != 0 {
                        write!(reader.get_mut(), "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                    }
                }
                bodies
            });
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            let body = payload("cnote:local-test", &[Event::Started]);
            assert_eq!(
                deliver_batch(&client, &address, &body, Duration::ZERO),
                expected
            );
            let bodies = received.join().unwrap();
            assert_eq!(bodies.len(), attempts);
            assert!(bodies.iter().all(|received| received == &body));
            assert!(uuid::Uuid::parse_str(body["batch"][0]["uuid"].as_str().unwrap()).is_ok());
        }
    }
    #[test]
    fn slow_upload_cannot_block_producers_and_queue_is_bounded() {
        let (tx, rx) = mpsc::sync_channel(CAPACITY);
        let (entered, wait) = mpsc::channel();
        let (release, blocked) = mpsc::channel::<()>();
        let thread = std::thread::spawn(move || {
            worker(rx, Duration::from_secs(30), |_| {
                let _ = entered.send(());
                let _ = blocked.recv();
            })
        });
        for _ in 0..BATCH_SIZE {
            tx.try_send(Message::Event(Event::Started)).unwrap();
        }
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 0..CAPACITY {
            tx.try_send(Message::Event(Event::Started)).unwrap();
        }
        assert!(matches!(
            tx.try_send(Message::Event(Event::Started)),
            Err(mpsc::TrySendError::Full(_))
        ));
        drop(tx);
        drop(release);
        thread.join().unwrap();
    }
}
