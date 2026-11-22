use soroban_sdk::{Address, Env, String, Vec};

use crate::emergency_pause::{
    admin::require_pause_authority,
    errors::PauseError,
    events::{emit_pause_audit, emit_paused, emit_unpaused, validate_reason},
    storage::{DataKey, PauseAuditRecord},
};
pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn assert_not_paused(env: &Env) -> Result<(), PauseError> {
    if is_paused(env) {
        return Err(PauseError::ContractPaused);
    }
    Ok(())
}

pub fn pause(env: Env, caller: Address, reason: String) -> Result<(), PauseError> {
    let actor = require_pause_authority(&env, &caller)?;

    if is_paused(&env) {
        return Err(PauseError::AlreadyPaused);
    }

    set_paused_internal(&env, true, &actor, reason)
}

pub fn unpause(env: Env, caller: Address, reason: String) -> Result<(), PauseError> {
    let actor = require_pause_authority(&env, &caller)?;

    if !is_paused(&env) {
        return Err(PauseError::NotPaused);
    }

    set_paused_internal(&env, false, &actor, reason)
}

/// Internal: Set pause state after authorization has been established by the caller.
pub fn set_paused_internal(
    env: &Env,
    paused: bool,
    actor: &Address,
    reason: String,
) -> Result<(), PauseError> {
    validate_reason(&reason)?;
    if paused && is_paused(env) {
        return Err(PauseError::AlreadyPaused);
    }
    if !paused && !is_paused(env) {
        return Err(PauseError::NotPaused);
    }

    let record = PauseAuditRecord {
        paused,
        actor: actor.clone(),
        reason: reason.clone(),
        ledger_sequence: env.ledger().sequence(),
        ledger_timestamp: env.ledger().timestamp(),
    };
    env.storage().instance().set(&DataKey::Paused, &paused);

    if paused {
        env.storage().instance().set(&DataKey::LastPause, &record);
        emit_paused(env, actor, reason.clone());
    } else {
        env.storage().instance().set(&DataKey::LastResume, &record);
        emit_unpaused(env, actor, reason.clone());
    }
    emit_pause_audit(env, paused, actor, reason);
    Ok(())
}

pub fn get_pause_audit(env: &Env) -> Vec<PauseAuditRecord> {
    let storage = env.storage().instance();
    let mut records = Vec::new(env);
    if let Some(record) = storage.get(&DataKey::LastPause) {
        records.push_back(record);
    }
    if let Some(record) = storage.get(&DataKey::LastResume) {
        records.push_back(record);
    }
    records
}
