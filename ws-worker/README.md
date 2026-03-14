## Cloudflare Worker Responsibilities

### Authentication & Connection
- Receive incoming WebSocket upgrade request from mobile client
- Extract JWT from query parameter in the WebSocket URL
- Validate JWT signature using RS256 public key stored as Worker secret
- Check JWT expiry, issuer, and audience claims
- Reject connection with 401 if token is invalid or expired
- Extract verified userId from JWT payload
- Set X-Verified-User-Id header before forwarding to UserGateway DO
- Route the verified request to the correct UserGateway DO using userId as key

---

### HTTP API Endpoints
- Validate JWT on every HTTP request, same as WebSocket
- Handle GET /upload-url — generate R2 pre-signed PUT and GET URLs for photo offline upload
- Return messageId, uploadUrl, downloadUrl, and expiresAt to client
- Handle DELETE /photo/{messageId} — delete R2 object after client confirms download
- Handle GET /ice-config — return TURN server credentials to client for WebRTC setup

---

### What the Worker Does NOT Do
- Never handles message content or routing — that belongs to UserGateway DO
- Never reads or writes to D1 directly — DO owns all DB operations
- Never calls FCM — that is Node.js responsibility
- Never holds any state between requests — fully stateless
- Never stores anything — purely a validation and routing layer