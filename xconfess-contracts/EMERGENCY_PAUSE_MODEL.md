# Unified Emergency Pause Model

## Overview

All admin-managed contracts in the xConfess workspace share a **unified emergency pause implementation** via the `emergency_pause` module. This ensures consistent pause semantics, authorization rules, and event handling across all contracts that support pause functionality.

## Module Architecture

The `emergency_pause` module is located at `xconfess-contracts/contracts/emergency_pause/` and provides:

- **Core Functions**: `pause()`, `unpause()`, `assert_not_paused()`, `is_paused()`
- **Admin Functions**: `get_admin()`, `set_admin()`, `require_admin()`
- **Event Emission**: `emit_paused()`, `emit_unpaused()`
- **Error Handling**: Standard `PauseError` enum with stable error codes
- **Storage**: Centralized `DataKey::Paused` boolean flag
- **Audit**: Latest pause and resume records are queryable; every successful
  transition emits a versioned `pause_audit` event with actor and ledger context

## Supported Contracts

### ConfessionRegistry ✅

**Pause Status**: Enabled
**Authorization**: Via governance (requires quorum approval)
**Blocked Operations**: `create_confession()`, `update_status()`, `delete_confession()`
**Allowed While Paused**: All read operations (`get_confession()`, `get_by_hash()`, `get_author_confessions()`, `get_total_count()`)

```rust
// In ConfessionRegistry operations:
emergency_pause::assert_not_paused(&env)
    .unwrap_or_else(|err| panic!("{}", err as u32));
```

**Pause via**: Governance proposal with `CriticalAction::Pause`

```rust
// In governance/logic.rs:
CriticalAction::Pause => {
    emergency_pause::set_paused_internal(&env, true);
}
CriticalAction::Unpause => {
    emergency_pause::set_paused_internal(&env, false);
}
```

### ConfessionAnchor ❌

**Pause Status**: Not enabled
**Reason**: Anchoring is read-only operational semantics (hash storage is immutable; overwrites are prevented)
**Migration Path**: Pause support can be added if future design requires write blocking

### ReputationBadges ❌

**Pause Status**: Not enabled
**Reason**: Badge system is independent functionality; pause would require its own governance if needed

### AnonymousTipping ❌

**Pause Status**: Not enabled
**Reason**: Fully decentralized; no admin control

## Error Codes

The `PauseError` enum uses stable numeric codes for operator integration:

```rust
pub enum PauseError {
    AlreadyPaused = 1,        // Attempt to pause already-paused contract
    NotPaused = 2,            // Attempt to unpause non-paused contract
    Unauthorized = 3,         // Caller lacks admin authorization
    ContractPaused = 4,       // Operation blocked due to pause
    ReasonTooLong = 5,        // Pause/resume reason exceeds 128 bytes
}
```

`confession-anchor` exposes `ReasonTooLong` as its stable contract error code
16 (`PauseReasonTooLong`); governance execution propagates the shared
`PauseError::ReasonTooLong` code 5.

When a blocked operation is attempted on a paused contract:
- Error code `4` is returned/panicked
- Event `(topic: "paused", actor)` emitted (from last pause action)

## Storage Layout

| Key | Type | Purpose | Access |
|-----|------|---------|--------|
| `DataKey::Paused` | `bool` | Current pause state | Instance storage |
| `DataKey::Admin` | `Address` | Pause admin (if direct pause enabled) | Instance storage |

All storage uses Soroban's instance storage (auto-renewed).

## Event Emissions

### Pause Event

```rust
Topic: ("paused", admin_address)
Data: reason: String
```

Emitted when contract is paused by admin action.

### Unpause Event

```rust
Topic: ("unpaused", admin_address)
Data: reason: String
```

Emitted when contract is unpaused by admin action.

**Note:** Governance-paused contracts emit these events via `set_paused_internal()` but only after quorum approval.

## Authorization Models

### Model 1: Governance-Based (ConfessionRegistry)

**Flow:**
1. Admin proposes `CriticalAction::Pause`
2. Other admins approve the proposal
3. Executor runs `gov_execute()` after quorum reached
4. `governance/logic.rs` calls `emergency_pause::set_paused_internal()`

**Decision Authority**: Collective (requires quorum)
**Timeline**: Multi-step with approval delays
**Use Case**: Standard administration, prevents single-admin abuse

### Model 2: Direct Admin Auth (Available for future use)

**Flow:**
1. Admin calls `emergency_pause::pause(env, reason)?`
2. Function checks `require_admin()`
3. Sets pause state and emits event

**Decision Authority**: Single admin
**Timeline**: Immediate
**Use Case**: Emergency response if needed

## Integration Points

### Backend (NestJS)

- Listen to `paused` and `unpaused` events
- Stop accepting new confessions when pause event detected
- Display pause notification to frontend
- Alert operators of pause changes

### Frontend (Next.js)

- Query `is_paused()` on load
- Disable write UI (create, update, delete) when paused
- Show maintenance banner explaining pause
- Enable read-only view (browse existing confessions)

### Off-Chain Indexer

- Track pause/unpause events for audit trail
- Align indexer state with contract state
- Alert on unexpected pause state changes
- Measure pause duration for SLA tracking

## Testing

All pause behavior is tested in `confession-registry/src/confession_reg_auth.rs`:

**Blocks C–E Test Suite**:
- `c1_create_blocked_while_paused` / `c2_create_succeeds_after_unpause`
- `d1_update_status_blocked_while_paused` / `d2_update_status_succeeds_after_unpause`
- `e1_delete_blocked_while_paused` / `e2_delete_succeeds_after_unpause`
- `f1_reads_are_not_blocked_by_pause` — Verifies read operations remain available

**Key Property**: When paused, read operations return fresh data while write operations fail with `PauseError::ContractPaused`.

### Pause and recovery audit

The shared pause module records the latest successful pause and resume
separately. Each record contains the transition, actor, free-text reason, ledger
sequence, and ledger timestamp. `get_pause_audit()` exposes those latest records on-chain;
the versioned `pause_audit` event is the append-only source for the complete
history. Legacy `paused` and `unpaused` events retain their existing topic and
payload.

Reasons are limited to 128 bytes. They are public on-chain; callers must not
include secrets, personal data, or other confidential information. Unauthorized
calls, duplicate pause/resume attempts, and oversized reasons fail without
changing state or emitting audit events. Legacy governance actions continue to
work and record a fixed reason; new `PauseWithReason` and `UnpauseWithReason`
governance actions accept explicit reasons.

The audit storage keys are additive and optional. Existing deployments need no
backfill or migration; the getter returns `None` for each record not yet
created, while the existing `Paused` key and legacy event payloads are
unchanged.

Rolling back to pre-audit WASM preserves the pause flag and legacy pause
behavior, but that code ignores the new audit keys and emits no `pause_audit`
events. Transitions made during rollback are therefore not included in the
stored latest records; the legacy events remain the only record for that
period, and no audit backfill is performed.

## Security Considerations

1. **Immutable History**: All pause/unpause actions emit events for full audit trail
2. **No Silent Pauses**: Pause state is explicitly stored and queryable
3. **No Timeout**: Pause persists until explicit unpause (no automatic expiry)
4. **Authorization**: Pause requires admin action; non-admins cannot pause
5. **Read Access**: Pause blocks mutations but not data access (transparency)
6. **State Consistency**: Pause affects only write operations; contract state remains queryable

## Upgrading Existing Contracts

To unify an ad-hoc pause implementation with the `emergency_pause` module:

1. **Add Module Import**:
   ```rust
   #[path = "../../emergency_pause/mod.rs"]
   mod emergency_pause;
   ```

2. **Replace Pause Checks**:
   ```rust
   // OLD: Raw storage check
   let paused: bool = env.storage().instance().get(&symbol_short!("paused")).unwrap_or(false);
   if paused { panic!("contract paused"); }

   // NEW: Emergency pause module
   emergency_pause::assert_not_paused(&env)
       .unwrap_or_else(|err| panic!("{}", err as u32));
   ```

3. **Update Pause Operations**:
   ```rust
   // OLD: Raw storage set
   e.storage().instance().set(&symbol_short!("paused"), &true);

   // NEW: For governance flows
   emergency_pause::set_paused_internal(&e, true);

   // NEW: For direct admin flows (if applicable)
   emergency_pause::pause(env, reason)?;
   ```

4. **Update Tests**: No changes needed if tests use `.try_*()` and check `.is_err()` (compatible with Result-based API)

## Future Enhancements

- **Pause Scheduling**: Automatic pause/unpause at specified times
- **Maintenance Windows**: Scheduled pause periods for planned maintenance
- **Pause Reasons Registry**: Categorize pause reasons (emergency, maintenance, upgrade)
- **Conditional Pause**: Pause specific operation types rather than whole contract
- **Multi-Sig Pause**: Require M-of-N admins for immediate pause (super-emergency)
