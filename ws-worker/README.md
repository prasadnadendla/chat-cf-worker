
---

## Cloudflare Worker Responsibilities

### On Every Request
- Extract JWT from query parameter on WebSocket upgrade requests
- Extract JWT from Authorization header on HTTP requests
- Validate JWT signature using RS256 public key stored as Worker secret
- Check expiry, issuer, and audience claims
- Reject with 401 if any check fails — request never reaches DO
- Call Node.js internal API to confirm chat is permitted for this user and target
- Reject with 403 if Node.js says not allowed
- Set X-Verified-User-Id header and forward to UserGateway DO

### HTTP Endpoints
- GET /ice-config — return TURN server credentials for WebRTC setup
- GET /upload-url — validate JWT, generate R2 pre-signed PUT and GET URLs for photo offline upload
- DELETE /photo/{messageId} — validate JWT, delete R2 object after client confirms download

---

---

## UserGateway DO Responsibilities

### Connection
- Accept WebSocket only from Worker — never directly from internet
- Trust X-Verified-User-Id set by Worker — no re-validation here
- Store active socket reference for this user
- Replace existing socket cleanly on reconnect
- Start heartbeat ping every 30 seconds
- Mark user offline and clean up socket on missed heartbeat or close event

---

### Presence
- Mark online on socket established
- Mark offline on socket close or missed heartbeat
- Respond to presence queries from other UserGateway DOs
- Broadcast online event to all relevant senders when user connects
- Broadcast offline event when user disconnects

---

### Outbound Message Handling
- Receive message from client over WebSocket
- Validate message structure — required fields, known type, valid matchId
- Enforce content rules — character limits, valid domains for GIF
- Enforce rate limits using DO storage — reset per time window per match
- Write metadata to D1 — sender, receiver, matchId, type, content hash, timestamp, expires_at
- Check recipient presence by querying recipient's UserGateway DO
- If online — call recipient's UserGateway DO to deliver directly
- If offline — build FCM payload and call Node.js internal API to dispatch

---

### Inbound Message Handling
- Accept delivery calls from other UserGateway DOs
- Push to client over active WebSocket immediately
- If socket dropped since presence was checked — trigger offline delivery path as fallback

---

### Ack Handling
- Receive DELIVERED ack from B's client
- Forward ack to A's UserGateway DO
- A's DO pushes ack to A's active socket
- Receive READ ack from B's client
- Forward READ ack to A's UserGateway DO in same way
- Receive edit event from A's client — relay to B's UserGateway DO
- Receive delete event from A's client — relay to B's UserGateway DO
- No D1 write for acks, edits, or deletes — client devices own that state

---

### WebRTC Signalling
- Receive rtc_offer, rtc_answer, rtc_ice, rtc_failed from client
- Relay to recipient's UserGateway DO tagged with matchId and senderId
- Recipient DO pushes to their client socket
- No metadata write — signalling is not content

---

### Presence-Triggered Voice Sync
- On user coming online, check if any connected senders have PENDING voice for this user
- This is known from the online broadcast — senders respond if they have pending voice
- Sender's client initiates WebRTC on receiving the presence event
- No D1 query needed — state lives on sender's device

---

### Offline Delivery
- Text / emoji / GIF — build FCM payload with full content, call Node.js internal API to dispatch
- Photo — build FCM payload with R2 signed URL and blurHash, call Node.js internal API to dispatch
- Voice — build silent FCM payload as wake signal only, call Node.js to internal API to dispatch
- Never calls FCM directly — always delegates to Node.js internal API

---

### What DO Does Not Do
- Does not validate JWT
- Does not check match validity or subscription — Node.js pre-approved the connection
- Does not store message content
- Does not call FCM directly
- Does not manage R2 uploads
- Does not process WebRTC media


## Apply DB migrations

`wrangler d1 migrations apply chat-metadata --remote`