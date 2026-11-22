# Moderation State Machine

Admin reference for content moderation transitions.

## States

| State | Meaning |
|---|---|
| `pending` | Awaiting initial review |
| `approved` | Passes moderation; visible to users |
| `flagged` | Suspicious; needs human review |
| `escalated` | Referred to senior moderators |
| `resolved` | Handled by a moderator |
| `hidden` | Removed from public view |
| `rejected` | Permanently denied |

## Allowed Transitions

| From | To | Trigger / Side Effect |
|---|---|---|
| `pending` | `approved` | Auto-approval or manual review — content becomes visible |
| `pending` | `flagged` | AI score above medium threshold — queued for review |
| `pending` | `rejected` | AI score above high threshold or manual reject |
| `approved` | `flagged` | Post-approval report or delayed AI flag |
| `flagged` | `escalated` | Moderator escalates to senior review |
| `flagged` | `resolved` | Moderator dismisses the flag |
| `flagged` | `hidden` | Moderator removes content |
| `flagged` | `rejected` | Moderator rejects content |
| `escalated` | `resolved` | Senior moderator clears the flag |
| `escalated` | `hidden` | Senior moderator removes content |
| `escalated` | `rejected` | Senior moderator rejects content |
| `resolved` | `flagged` | Re-flagged if new reports arrive |
| `hidden` | `resolved` | Content restored after review |
| `rejected` | `pending` | Appeal or manual requeue for re-review |

Self-transitions (`X → X`) are always rejected.

## Public rendering and report lifecycle

The public confession contract exposes only `contentWarning`, a boolean
derived from the review-required/flagged state. Scores, moderation categories,
and provider details remain private. Feed cards, search previews, and detail
pages collapse warned text by default; the reader may reveal it for the
current view, or use the existing privacy preference to opt out of collapsing.
Notification items link to the detail page instead of embedding confession
text, so the same warning and availability checks apply there. Hidden and
deleted confessions are excluded from public reads and cannot receive new
reports.

Reports are created only for an available confession and an identified
reporter (anonymous identity or wallet). Repeated reports from the same
reporter within 24 hours return the existing report rather than creating a
duplicate. `pending` and `reviewing` reports may be resolved or dismissed;
`resolved` and `dismissed` are terminal, and attempts to change either status
again are rejected. Failed requests do not mark the report successful in the
UI and may be retried.

Hiding requires moderator capability and step-up verification and immediately
invalidates public confession caches. Deletion remains a two-administrator
workflow: the requester submits an approval request, and a different
administrator must approve it before deletion executes. Expired or failed
approval operations do not delete the confession.

These are API and rendering behavior changes only; no database migration is
required. Existing records derive the public warning from their current
moderation fields, and clients that ignore the optional `contentWarning` field
remain compatible.

## Side Effects

- **Audit log** — every transition is recorded via `ModerationLog`
- **Notifications** — users are notified on `approved`, `rejected`, and `hidden` transitions
- **Event emitter** — `moderation.status.changed` event fired on every valid transition

## Moderator Calibration

Admins with the moderation capability can create a calibration session through
`POST /api/admin/moderation/calibration-sessions`, list its selected cases at
`GET /api/admin/moderation/calibration-sessions/:sessionId/cases`, submit
interpretations at `POST .../:sessionId/assessments`, and view aggregate
agreement at `GET .../:sessionId/results`.

Sessions accept only case IDs from the checked-in synthetic moderation corpus.
The cases response omits reference labels, and result responses contain
decision counts and agreement rates but no reviewer identities or reference
categories. Sessions live in process memory for at most two hours; they are
lost on restart and require requests to reach the same backend instance.
Unknown sessions return `404`, expired sessions return `410`, and duplicate
reviewer decisions return `409`. Do not submit live reporter content or
identifiers to this workflow.

## Code References

- State machine logic: `src/moderation/moderation-state-machine.ts`
- State machine tests: `src/moderation/moderation-state-machine.spec.ts`
- AI moderation service: `src/moderation/ai-moderation.service.ts`
- Moderation controller: `src/moderation/moderation.controller.ts`
- Moderation log entity: `src/moderation/entities/moderation-log.entity.ts`
