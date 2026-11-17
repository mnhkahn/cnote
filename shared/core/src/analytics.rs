//! Forward anonymous events to the host's existing opt-in analytics.
use serde::Serialize;
#[derive(Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    NoteCreated,
    NoteDeleted,
    Cloud {
        operation: Operation,
        outcome: Outcome,
        duration_ms: u64,
    },
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Restore,
    Login,
    Logout,
    List,
    Download,
    Upload,
    Delete,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Failure,
    Conflict,
    LoggedOut,
}
pub fn capture(event: Event) {
    crate::platform::emit(serde_json::json!({"type":"analytics", "data":event}));
}
