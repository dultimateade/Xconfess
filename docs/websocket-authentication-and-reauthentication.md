# WebSocket Authentication and Reauthentication Protocol

## Overview
Long-lived WebSocket connections require explicit handling when authentication tokens expire, session cookies change, or user roles/permissions are revoked. This protocol defines the lifecycle from handshake to in-flight re-authentication and server-initiated revocation.

## 1. Handshake Authentication
When establishing a connection, clients MUST provide valid credentials through one of three prioritized vectors:
1. `handshake.auth.token` (Primary: Recommended Socket.io client configuration)
2. `Authorization: Bearer <token>` HTTP header
3. Secure HttpOnly cookies (`token`, `access_token`, or `jwt`)

Handshake verification is enforced by `WsJwtGuard`. Missing or expired tokens are rejected with standard error codes (`NO_TOKEN_PROVIDED`, `EXPIRED_TOKEN`, `MALFORMED_TOKEN`). Sensitive headers are scrubbed from socket instances to prevent credential leakage into logs.

## 2. In-Flight Reauthentication (`auth:refresh`)
To prevent connection drops when short-lived access tokens expire:
- The client emits an `auth:refresh` event with the newly refreshed JWT:
  ```json
  // Client -> Server
  {
    "token": "<new_jwt_access_token>"
  }
  ```
- The server validates the new token:
  - **Success**: Server updates the socket's attached `userId` and user room subscriptions, returning:
    ```json
    // Server -> Client
    {
      "success": true,
      "userId": "123",
      "timestamp": "2026-09-25T08:00:00.000Z"
    }
    ```
  - **Failure**: If the token is invalid, malformed, or revoked, the server emits `auth:revoked` and immediately closes the underlying socket (`disconnect(true)`).

## 3. Server-Initiated Revocation Disconnects
When a user logs out, rotates passwords, or is deactivated by moderation:
- The backend triggers `NotificationGateway.revokeUserSessions(userId, reason)`.
- All open sockets belonging to that user receive an `auth:revoked` payload:
  ```json
  {
    "reason": "SESSION_REVOKED",
    "timestamp": "2026-09-25T08:00:00.000Z"
  }
  ```
- All sockets are immediately terminated server-side.

## 4. Channel Authorization Boundaries
- Sockets are automatically isolated into private rooms (`user:<userId>`).
- Subscription requests to other user channels are strictly rejected with `subscription:rejected`.

## 5. Notification and Moderation Connection Behavior

The `/notifications` and `/admin` namespaces require valid JWTs before joining
any private event room. Notification sockets also require a well-formed
positive numeric subject for an active account and join only
`user:<userId>`. Moderation/report events are delivered only to active admin
sockets in `admin:events`; inactive accounts and non-admin roles are
disconnected before joining that room. If the account lookup fails, the
connection fails closed and the client may reconnect after service recovery.

Both gateways accept `auth:refresh` for in-place renewal:

- A valid token for the same or another active account updates socket identity
  and tracking before `auth:refreshed` is emitted. Notification sockets leave
  the old user's room before joining the new user's room. Moderation sockets
  remain in the admin event family only if the new account is also an active
  admin; otherwise they receive `auth:revoked` and are disconnected.
- The refresh message is exempt from the notification per-message JWT guard so
  an expired handshake token can be replaced. Other guarded messages use the
  successfully refreshed token.
- A refresh without a token returns `auth:rejected` with
  `NO_TOKEN_PROVIDED`; the current connection remains open so the client can
  retry with a token.
- An expired, invalid, revoked, inactive, or unauthorized refreshed identity
  receives `auth:revoked` and is disconnected. The client must establish a new
  connection after obtaining valid credentials; retrying the same rejected
  token is not supported.
- Administrative session revocation first persists revocation, then emits
  `auth:revoked` and disconnects the user's active notification and moderation
  sockets. A user with no active sockets is a successful no-op.

Handshake failures (anonymous, invalid, or expired credentials) are rejected
before private room joins. A later successful reconnect is the recovery path.
Existing event names and payloads are unchanged; `auth:refresh`,
`auth:refreshed`, `auth:rejected`, and `auth:revoked` define the connection
lifecycle contract.
