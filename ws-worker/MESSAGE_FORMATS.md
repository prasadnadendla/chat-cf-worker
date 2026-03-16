# WebSocket Message Formats

All messages are JSON-encoded strings sent over a single WebSocket connection per user.

The server resolves the recipient from `matchId` — a match is always between exactly two users, so `receiverId` is never needed in client messages.

## Connection

```
wss://ws-worker.<your-domain>.workers.dev/?token=<JWT>
```

The JWT must contain `aud: "genzyy-app"` and `iss: "auth.genzyy.in"`. User ID is extracted from `userId`, `uid`, or `sub` claim (first available).

---

## Client → Server

### Text Message

```json
{
  "type": "text",
  "matchId": "match-abc-123",
  "seq_no": 1,
  "content": "Hey, how are you?"
}
```

- `content`: 1–1000 characters

### Emoji Message

```json
{
  "type": "emoji",
  "matchId": "match-abc-123",
  "seq_no": 2,
  "content": "😍"
}
```

### GIF Message

```json
{
  "type": "gif",
  "matchId": "match-abc-123",
  "seq_no": 3,
  "url": "https://media.tenor.com/abc123/gif"
}
```

- `url`: must be from `tenor.com` domain

### Photo Message

```json
{
  "type": "photo",
  "matchId": "match-abc-123",
  "seq_no": 4,
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "blurHash": "LEHV6nWB2yk8pyo0adR*.7kCMdnj"
}
```

- `messageId`: obtained from `GET /upload-url` — upload photo to R2 first, then send this message
- `blurHash`: optional placeholder hash for the photo (used in FCM notification)

### Voice Message

```json
{
  "type": "voice",
  "matchId": "match-abc-123",
  "seq_no": 5
}
```

- No content — audio is delivered via WebRTC

### Delivery Ack

Sent when the client **receives** a message from another user.

```json
{
  "type": "ack",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "matchId": "match-abc-123"
}
```

### Read Ack

Sent when the client has **read** a message.

```json
{
  "type": "read",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "matchId": "match-abc-123"
}
```

### Edit Message

```json
{
  "type": "edit",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "matchId": "match-abc-123",
  "content": "Updated message text"
}
```

### Delete Message

```json
{
  "type": "delete",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "matchId": "match-abc-123"
}
```

### Pong (Heartbeat Response)

```json
{
  "type": "pong"
}
```

- Send in response to a `ping` from the server within 60 seconds

### Refresh Matches

```json
{
  "type": "refresh_matches"
}
```

- Triggers a reload of the user's match list from the API

### WebRTC Signalling

```json
{
  "type": "rtc_offer",
  "matchId": "match-abc-123",
  "payload": { "sdp": "v=0\r\n..." }
}
```

Types: `rtc_offer`, `rtc_answer`, `rtc_ice`, `rtc_failed`

- `payload`: opaque WebRTC data (SDP offer/answer, ICE candidate, or failure info)

---

## Server → Client

### Message Delivery

Received when another user sends you a message.

```json
{
  "type": "message",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "matchId": "match-abc-123",
  "senderId": "669277c5-480d-40a1-a483-00d9451666xx",
  "messageType": "text",
  "content": "Hey, how are you?",
  "timestamp": 1773594925000
}
```

Field availability by `messageType`:

| messageType | `content` | `url` |
|---|---|---|
| `text` | message text | — |
| `emoji` | emoji string | — |
| `gif` | — | Tenor GIF URL |
| `photo` | — | R2 signed download URL |
| `voice` | — | — |

### Server Ack

Confirms your message was processed by the server.

```json
{
  "type": "ack",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "seq_no": 1,
  "timestamp": 1773594925000
}
```

- `seq_no` matches the `seq_no` you sent — use it to correlate pending messages
- `seq_no: -1` indicates a delivery ack forwarded from the recipient (they received your message)

### Read Ack

The recipient has read your message.

```json
{
  "type": "read",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "senderId": "669277c5-480d-40a1-a483-00d9451666xx",
  "timestamp": 1773594930000
}
```

- `senderId`: the user who read the message (i.e. the one you sent it to)

### Edit Notification

The sender edited a previously sent message.

```json
{
  "type": "edit",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "matchId": "match-abc-123",
  "senderId": "669277c5-480d-40a1-a483-00d9451666xx",
  "content": "Updated message text",
  "timestamp": 1773594935000
}
```

### Delete Notification

The sender deleted a message.

```json
{
  "type": "delete",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "matchId": "match-abc-123",
  "senderId": "669277c5-480d-40a1-a483-00d9451666xx",
  "timestamp": 1773594940000
}
```

### Presence Event

A matched user came online or went offline.

```json
{
  "type": "presence",
  "userId": "669277c5-480d-40a1-a483-00d9451666xx",
  "online": true
}
```

### Unmatch Event

A match was removed.

```json
{
  "type": "unmatch",
  "matchId": "match-abc-123"
}
```

### Ping (Heartbeat)

```json
{
  "type": "ping"
}
```

- Server sends every 30 seconds — respond with `{"type": "pong"}` within 60 seconds or the connection is closed

### Error

```json
{
  "type": "error",
  "message": "Invalid matchId",
  "seq_no": 1
}
```

- `seq_no`: included when the error relates to a specific message you sent; absent for general errors

Common error messages:
- `"Invalid JSON"` — message could not be parsed
- `"Unknown message type"` — unrecognized `type` field
- `"Invalid matchId"` — matchId not in your active matches
- `"Missing required fields: matchId, seq_no"`
- `"Text must be 1-1000 characters"`
- `"Missing emoji content"`
- `"GIF URL must be from tenor.com"` / `"Invalid GIF URL"`
- `"Missing photo messageId"`
- `"Rate limit exceeded"` — max 30 messages per minute per match

### WebRTC Signal (Relayed)

```json
{
  "type": "rtc_offer",
  "matchId": "match-abc-123",
  "senderId": "669277c5-480d-40a1-a483-00d9451666xx",
  "payload": { "sdp": "v=0\r\n..." }
}
```

Types: `rtc_offer`, `rtc_answer`, `rtc_ice`, `rtc_failed`

- Server adds `senderId` so you know who sent the signal

---

## HTTP Endpoints

All endpoints require JWT in the `Authorization: Bearer <token>` header.

### GET /upload-url

Get a pre-signed URL to upload a photo to R2.

**Response:**

```json
{
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "uploadUrl": "https://<account>.r2.cloudflarestorage.com/genzyy-convo/photos/<userId>/<messageId>?X-Amz-...",
  "downloadUrl": "https://<account>.r2.cloudflarestorage.com/genzyy-convo/photos/<userId>/<messageId>?X-Amz-...",
  "expiresAt": "2026-03-16T12:00:00.000Z"
}
```

**Flow:**
1. `GET /upload-url` → receive `messageId` + `uploadUrl`
2. `PUT uploadUrl` with image body to upload to R2
3. Send `{ "type": "photo", "matchId": "...", "messageId": "<messageId>", ... }` over WebSocket

### DELETE /photo/:messageId

Delete a photo from R2 after the recipient has downloaded it.

**Response:**

```json
{
  "deleted": true
}
```

### GET /ice-config

Get TURN server credentials for WebRTC.

**Response:**

```json
{
  "iceServers": [
    {
      "urls": ["turn:turn.example.com:3478"],
      "username": "user",
      "credential": "pass"
    }
  ]
}
```

---

## Message Flow Examples

### Sending a text message (A → B)

```
A (client)                    A (DO)                     B (DO)                    B (client)
    |                           |                          |                          |
    |-- text {matchId} ------->|                           |                          |
    |                          |-- resolve receiverId ---->|                          |
    |                          |-- hasActiveSocket() ----->|                          |
    |                          |<---- true ----------------|                          |
    |                          |-- deliverMessage() ------>|                          |
    |                          |                           |-- message {senderId} --->|
    |<-- ack {seq_no: 1} -----|                            |                          |
    |                          |                           |                          |
    |                          |                           |<-- ack {matchId} --------|
    |                          |<-- deliverAck() ----------|                          |
    |<-- ack {seq_no: -1} ----|                            |                          |
```

### Sending when recipient is offline (A → B offline)

```
A (client)                    A (DO)                     B (DO)             Node.js API
    |                           |                          |                     |
    |-- text {matchId} ------->|                           |                     |
    |                          |-- hasActiveSocket() ----->|                     |
    |                          |<---- false ---------------|                     |
    |                          |-- POST /fcm/send -------------------------------->|
    |<-- ack {seq_no: 1} -----|                            |                     |
```

### Read receipt flow

```
B (client)                    B (DO)                     A (DO)                A (client)
    |                           |                          |                      |
    |-- read {matchId} ------->|                           |                      |
    |                          |-- relayReadAck() -------->|                      |
    |                          |                           |-- read {senderId} -->|
```
