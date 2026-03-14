# ws-worker — Chat WebSocket Gateway

Stateless Cloudflare Worker that authenticates clients and routes connections to per-user UserGateway Durable Objects.

## Architecture

```
Mobile Client ──► Worker (JWT validation) ──► UserGateway DO (per-user)
                     │                              │
                     ├── GET  /upload-url            ├── WebSocket lifecycle + heartbeat
                     ├── DELETE /photo/:id           ├── Message validation, routing, delivery
                     └── GET  /ice-config            ├── Presence broadcast to matches
                                                     ├── WebRTC signalling relay
                                                     ├── Offline → FCM via Node.js API
                                                     └── D1 reads/writes (messages, matches, pending)
```

## Worker (src/index.ts)

- Validates JWT (RS256) on every request — token from `Authorization: Bearer` header or `?token=` query param
- Extracts `userId` from JWT payload, sets `X-Verified-User-Id` header
- Routes WebSocket upgrades to UserGateway DO keyed by `userId`
- Serves HTTP API: upload-url, photo delete, ice-config
- **Never** handles message content, D1, FCM, or holds state

## UserGateway DO (src/gateway.ts)

One Durable Object instance per user. Owns all real-time state for that user.

### Connection
- Single WebSocket per user — new connection replaces old
- Heartbeat ping every 30s via DO alarm; closes after 60s without pong
- Hibernation API (`ctx.acceptWebSocket`) — DO sleeps between messages
- State restored from DO storage on hibernation wake (`ensureState()`)

### Message Flow (Outbound)
1. Validate structure, matchId, content rules, rate limit (30/min/match)
2. Hash content → write metadata to D1 (content never stored)
3. Check recipient's DO presence via RPC `hasActiveSocket()`
4. Online → `deliverMessage()` RPC | Offline → FCM via Node.js API + pending job in D1

### Message Flow (Inbound)
- `deliverMessage(msg)` RPC pushes to client via WebSocket
- Falls back to offline path if socket is gone

### Presence
- On connect: notify all active matches (online)
- On disconnect/heartbeat fail: notify all matches (offline)
- `hasActiveSocket()` RPC for presence checks

### WebRTC Signalling
- Relay `rtc_offer/answer/ice/failed` to recipient's DO — pure passthrough, no storage
- Server tags each signal with `senderId` for security

### Offline Delivery
- Builds FCM payload (full content for text/emoji/gif/photo, silent for voice)
- Calls `{NODE_API_URL}/fcm/send` with `Bearer {NODE_API_KEY}`
- Writes pending job to D1 with 7-day expiry
- Client ack marks pending delivery as delivered

### Voice Sync
- On connect: checks D1 for pending voice jobs where this user is receiver
- Notifies sender's DO via `notifyVoiceReady()` → sender's client initiates WebRTC

### Match Awareness
- Loads active matches from D1 on connection, caches in DO storage
- Client can send `refresh_matches` to reload from D1
- Messages rejected if matchId not in active list
- `notifyUnmatch(matchId)` RPC removes match and signals client to clean up

## Message Protocol

### Client → Server
| type | Fields | Notes |
|------|--------|-------|
| `text` | matchId, receiverId, seq_no, content | Max 1000 chars |
| `emoji` | matchId, receiverId, seq_no, content | |
| `gif` | matchId, receiverId, seq_no, url | Must be tenor.com |
| `photo` | matchId, receiverId, seq_no, messageId | messageId from /upload-url |
| `voice` | matchId, receiverId, seq_no | Delivered via WebRTC |
| `rtc_offer/answer/ice/failed` | matchId, receiverId, payload | |
| `ack` | messageId | Confirms delivery receipt |
| `pong` | | Heartbeat response |
| `refresh_matches` | | Reload matches from D1 |

### Server → Client
| type | Fields |
|------|--------|
| `message` | messageId, matchId, senderId, messageType, content?, url?, timestamp |
| `ack` | messageId, seq_no, timestamp |
| `presence` | userId, online |
| `unmatch` | matchId |
| `voice_ready` | matchId, senderId, messageId |
| `ping` | |
| `error` | message, seq_no? |
| `rtc_offer/answer/ice/failed` | matchId, senderId, payload |

## Bindings

| Binding | Type | Source |
|---------|------|--------|
| `USER_GATEWAY` | Durable Object | wrangler.jsonc |
| `DB` | D1 Database (`chat-db`) | wrangler.jsonc |
| `PHOTOS_BUCKET` | R2 Bucket (`chat-photos`) | wrangler.jsonc |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Vars | wrangler.jsonc |
| `R2_BUCKET_NAME`, `TURN_URLS`, `NODE_API_URL` | Vars | wrangler.jsonc |
| `JWT_PUBLIC_KEY` | Secret | `wrangler secret put` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` | Secrets | `wrangler secret put` |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | Secrets | `wrangler secret put` |
| `NODE_API_KEY` | Secret | `wrangler secret put` |

Run `wrangler types` after changing bindings. Secret types declared in `src/env.d.ts`.

## D1 Schema

Tables in `migrations/0001_init.sql`:
- **messages** — id, match_id, sender_id, receiver_id, type, content_hash, timestamp, delivered
- **pending_deliveries** — id, message_id, receiver_id, sender_id, match_id, type, fcm_payload, expires_at, delivered
- **matches** — match_id, user_id, matched_user_id, active

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker fetch handler, JWT validation, HTTP routes, re-exports UserGateway |
| `src/gateway.ts` | UserGateway DO — WebSocket, messages, presence, signalling |
| `src/types.ts` | Client/server message protocol types |
| `src/env.d.ts` | Secret binding type declarations |
| `wrangler.jsonc` | Worker config, all bindings |
| `migrations/0001_init.sql` | D1 schema |

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local development (wrangler dev) |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate TypeScript types |
| `wrangler d1 create chat-db` | Create D1 database |
| `wrangler d1 migrations apply chat-db` | Apply D1 schema |

## Code Conventions

- JWT validated with Web Crypto API (no external JWT library)
- R2 presigned URLs via `aws4fetch` (S3-compatible signing)
- R2 photo keys: `photos/{userId}/{messageId}`
- Rate limits stored in DO storage as `rate:{matchId}`
- Matches cached in DO storage as `cachedMatches` for hibernation
- All endpoints return JSON with CORS headers
- DO RPC methods are public; internal methods are private
- Strict TypeScript — avoid `any`

## Cloudflare Reference

- Docs: https://developers.cloudflare.com/workers/
- Durable Objects: https://developers.cloudflare.com/durable-objects/
- D1: https://developers.cloudflare.com/d1/
- R2: https://developers.cloudflare.com/r2/
