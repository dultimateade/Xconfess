use soroban_sdk::{contractevent, Address, Env, String};

pub const MAX_PAUSE_REASON_LEN: u32 = 128;
pub const PAUSE_AUDIT_EVENT_VERSION: u32 = 1;

#[contractevent(topics = ["paused"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedEvent {
    #[topic]
    pub actor: Address,
    pub reason: String,
}

#[contractevent(topics = ["unpaused"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnpausedEvent {
    #[topic]
    pub actor: Address,
    pub reason: String,
}

#[contractevent(topics = ["pause_audit"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseAuditEvent {
    pub event_version: u32,
    pub paused: bool,
    pub actor: Address,
    pub reason: String,
    pub ledger_sequence: u32,
    pub ledger_timestamp: u64,
}

pub fn validate_reason(reason: &String) -> Result<(), crate::emergency_pause::errors::PauseError> {
    if reason.len() > MAX_PAUSE_REASON_LEN {
        return Err(crate::emergency_pause::errors::PauseError::ReasonTooLong);
    }
    Ok(())
}

pub fn emit_paused(env: &Env, actor: &Address, reason: String) {
    PausedEvent {
        actor: actor.clone(),
        reason,
    }
    .publish(env);
}

pub fn emit_unpaused(env: &Env, actor: &Address, reason: String) {
    UnpausedEvent {
        actor: actor.clone(),
        reason,
    }
    .publish(env);
}

pub fn emit_pause_audit(env: &Env, paused: bool, actor: &Address, reason: String) {
    PauseAuditEvent {
        event_version: PAUSE_AUDIT_EVENT_VERSION,
        paused,
        actor: actor.clone(),
        reason,
        ledger_sequence: env.ledger().sequence(),
        ledger_timestamp: env.ledger().timestamp(),
    }
    .publish(env);
}
