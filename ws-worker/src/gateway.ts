import { DurableObject } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";
import type {
	ClientMessage,
	ContentMessage,
	ServerDelivery,
	ServerAck,
	ServerReadAck,
	ServerEdit,
	ServerDelete,
	ServerMessage,
	PresenceEvent,
	UnmatchEvent,
	RelayedSignal,
	RTCSignal,
	ClientEdit,
	ClientDelete,
	Match,
	RateWindow,
	ContentType,
} from "./types";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const MAX_TEXT_LENGTH = 1000;
const TENOR_DOMAIN = "tenor.com";

export class UserGateway extends DurableObject<Env> {
	private userId: string | null = null;
	private matches = new Map<string, Match>();
	private matchesLoaded = false;

	// ── Connection Management ──────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}

		this.userId = request.headers.get("X-Verified-User-Id");
		if (!this.userId) {
			return new Response("Missing user ID", { status: 400 });
		}

		// Single connection per user — close existing socket
		for (const ws of this.ctx.getWebSockets()) {
			ws.close(1000, "Replaced by new connection");
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);

		// Persist connection metadata
		await this.ctx.storage.put("userId", this.userId);
		await this.ctx.storage.put("connectedAt", Date.now());
		await this.ctx.storage.put("lastPong", Date.now());

		const deviceInfo = request.headers.get("X-Device-Info");
		if (deviceInfo) {
			await this.ctx.storage.put("deviceInfo", deviceInfo);
		}

		// Bootstrap state
		await this.loadMatches();
		await this.markOnline();
		// Voice sync: presence broadcast notifies senders who hold pending voice state on-device

		// Start heartbeat alarm
		await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);

		return new Response(null, { status: 101, webSocket: client });
	}

	// ── Heartbeat (Alarm) ──────────────────────────────────────────────

	async alarm(): Promise<void> {
		const sockets = this.ctx.getWebSockets();
		if (sockets.length === 0) {
			await this.markOffline();
			return;
		}

		const lastPong =
			(await this.ctx.storage.get<number>("lastPong")) ?? 0;

		if (Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS) {
			for (const ws of sockets) {
				ws.close(1001, "Heartbeat timeout");
			}
			await this.markOffline();
			return;
		}

		for (const ws of sockets) {
			this.safeSend(ws, { type: "ping" });
		}

		await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
	}

	// ── WebSocket Event Handlers ───────────────────────────────────────

	async webSocketMessage(
		ws: WebSocket,
		raw: string | ArrayBuffer,
	): Promise<void> {
		if (typeof raw !== "string") return;

		let msg: ClientMessage;
		try {
			msg = JSON.parse(raw);
		} catch {
			this.safeSend(ws, { type: "error", message: "Invalid JSON" });
			return;
		}

		await this.ensureState();

		switch (msg.type) {
			case "pong":
				await this.ctx.storage.put("lastPong", Date.now());
				break;

			case "ack":
				await this.handleClientAck(msg.messageId, msg.senderId);
				break;

			case "read":
				await this.handleReadAck(msg.messageId, msg.senderId);
				break;

			case "edit":
				await this.handleEdit(msg);
				break;

			case "delete":
				await this.handleDelete(msg);
				break;

			case "text":
			case "emoji":
			case "gif":
			case "photo":
			case "voice":
				await this.handleOutboundMessage(ws, msg);
				break;

			case "rtc_offer":
			case "rtc_answer":
			case "rtc_ice":
			case "rtc_failed":
				await this.handleRTCSignal(msg);
				break;

			case "refresh_matches":
				await this.loadMatches();
				break;

			default:
				this.safeSend(ws, {
					type: "error",
					message: "Unknown message type",
				});
		}
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		ws.close(code, reason);
		await this.ensureState();
		await this.markOffline();
	}

	async webSocketError(
		ws: WebSocket,
		_error: unknown,
	): Promise<void> {
		ws.close(1011, "Unexpected error");
		await this.ensureState();
		await this.markOffline();
	}

	// ── RPC Methods (called by other UserGateway DOs) ──────────────────

	async hasActiveSocket(): Promise<boolean> {
		return this.ctx.getWebSockets().length > 0;
	}

	async deliverMessage(message: ServerDelivery): Promise<boolean> {
		const sockets = this.ctx.getWebSockets();
		if (sockets.length === 0) return false;

		for (const ws of sockets) {
			this.safeSend(ws, message);
		}
		return true;
	}

	async deliverAck(messageId: string): Promise<void> {
		const ack: ServerAck = {
			type: "ack",
			messageId,
			seq_no: -1,
			timestamp: Date.now(),
		};
		for (const ws of this.ctx.getWebSockets()) {
			this.safeSend(ws, ack);
		}
	}

	async relayReadAck(event: ServerReadAck): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			this.safeSend(ws, event);
		}
	}

	async relayEdit(event: ServerEdit): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			this.safeSend(ws, event);
		}
	}

	async relayDelete(event: ServerDelete): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			this.safeSend(ws, event);
		}
	}

	async relaySignal(signal: RelayedSignal): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			this.safeSend(ws, signal);
		}
	}

	async notifyPresence(userId: string, online: boolean): Promise<void> {
		const event: PresenceEvent = { type: "presence", userId, online };
		for (const ws of this.ctx.getWebSockets()) {
			this.safeSend(ws, event);
		}
	}

	async notifyUnmatch(matchId: string): Promise<void> {
		this.matches.delete(matchId);
		await this.ctx.storage.delete(`cachedMatches`);

		const event: UnmatchEvent = { type: "unmatch", matchId };
		for (const ws of this.ctx.getWebSockets()) {
			this.safeSend(ws, event);
		}
	}

	// ── Outbound Message Handling ──────────────────────────────────────

	private async handleOutboundMessage(
		ws: WebSocket,
		msg: ContentMessage,
	): Promise<void> {
		const userId = await this.getUserId();

		// Validate match
		if (!this.matches.has(msg.matchId)) {
			this.safeSend(ws, {
				type: "error",
				message: "Invalid matchId",
				seq_no: msg.seq_no,
			});
			return;
		}

		// Validate content
		const err = this.validateContent(msg);
		if (err) {
			this.safeSend(ws, { type: "error", message: err, seq_no: msg.seq_no });
			return;
		}

		// Rate limit
		if (!(await this.checkRateLimit(msg.matchId))) {
			this.safeSend(ws, {
				type: "error",
				message: "Rate limit exceeded",
				seq_no: msg.seq_no,
			});
			return;
		}

		const messageId = crypto.randomUUID();
		const timestamp = Date.now();
		const contentHash = await this.hashContent(msg);

		// Write metadata to D1
		const expiresAt = timestamp + 7 * 24 * 60 * 60 * 1000;
		await this.env.DB.prepare(
			`INSERT INTO messages (id, match_id, sender_id, receiver_id, type, content_hash, timestamp, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				messageId,
				msg.matchId,
				userId,
				msg.receiverId,
				msg.type,
				contentHash,
				timestamp,
				expiresAt,
			)
			.run();

		// Build delivery payload
		const delivery: ServerDelivery = {
			type: "message",
			messageId,
			matchId: msg.matchId,
			senderId: userId,
			messageType: msg.type,
			timestamp,
		};

		if (msg.type === "text" || msg.type === "emoji") {
			delivery.content = msg.content;
		} else if (msg.type === "gif") {
			delivery.url = msg.url;
		} else if (msg.type === "photo") {
			delivery.url = await this.generateR2SignedUrl(userId, msg.messageId);
		}
		// voice — no content, delivered via WebRTC

		// Route to recipient
		const recipientStub = this.env.USER_GATEWAY.get(
			this.env.USER_GATEWAY.idFromName(msg.receiverId),
		);

		let delivered = false;
		try {
			if (await recipientStub.hasActiveSocket()) {
				delivered = await recipientStub.deliverMessage(delivery);
			}
		} catch {
			// Recipient DO unreachable — treat as offline
		}

		if (!delivered) {
			await this.handleOfflineDelivery(
				messageId,
				msg,
				delivery,
				timestamp,
			);
		}

		// Ack back to sender
		const ack: ServerAck = {
			type: "ack",
			messageId,
			seq_no: msg.seq_no,
			timestamp,
		};
		this.safeSend(ws, ack);
	}

	// ── Offline Delivery ───────────────────────────────────────────────

	private async handleOfflineDelivery(
		messageId: string,
		msg: ContentMessage,
		delivery: ServerDelivery,
		timestamp: number,
	): Promise<void> {
		const fcmPayload: Record<string, unknown> = {
			messageId,
			matchId: msg.matchId,
			senderId: delivery.senderId,
			type: msg.type,
			timestamp,
		};

		switch (msg.type) {
			case "text":
			case "emoji":
				fcmPayload.content = msg.content;
				break;
			case "gif":
				fcmPayload.url = msg.url;
				break;
			case "photo":
				fcmPayload.url = delivery.url;
				if (msg.blurHash) fcmPayload.blurHash = msg.blurHash;
				break;
			case "voice":
				fcmPayload.silent = true;
				break;
		}

		// Dispatch FCM via Node.js API
		try {
			await fetch(`${this.env.NODE_API_URL}/fcm/send`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.env.NODE_API_KEY}`,
				},
				body: JSON.stringify({
					userId: msg.receiverId,
					payload: fcmPayload,
				}),
			});
		} catch {
			// FCM dispatch failed — pending job is still recorded below
		}

		// Write pending delivery to D1
		// TODO: hold voice messages for x amount of time and deliver when the respective user online
	}

	// ── WebRTC Signalling ──────────────────────────────────────────────

	private async handleRTCSignal(signal: RTCSignal): Promise<void> {
		const userId = await this.getUserId();

		const relayed: RelayedSignal = {
			type: signal.type,
			matchId: signal.matchId,
			senderId: userId,
			payload: signal.payload,
		};

		const recipientStub = this.env.USER_GATEWAY.get(
			this.env.USER_GATEWAY.idFromName(signal.receiverId),
		);

		try {
			await recipientStub.relaySignal(relayed);
		} catch {
			// Recipient unreachable — WebRTC will handle retry
		}
	}

	// ── Client Ack ─────────────────────────────────────────────────────

	private async handleClientAck(
		messageId: string,
		senderId: string,
	): Promise<void> {
		// Notify the original sender that receiver got the message
		const senderStub = this.env.USER_GATEWAY.get(
			this.env.USER_GATEWAY.idFromName(senderId),
		);

		try {
			await senderStub.deliverAck(messageId);
		} catch {
			// Sender offline — they'll see delivered status on reconnect
		}
	}

	// ── Read Ack / Edit / Delete Relay ─────────────────────────────────

	private async handleReadAck(
		messageId: string,
		senderId: string,
	): Promise<void> {
		const userId = await this.getUserId();
		const senderStub = this.env.USER_GATEWAY.get(
			this.env.USER_GATEWAY.idFromName(senderId),
		);
		try {
			await senderStub.relayReadAck({
				type: "read",
				messageId,
				senderId: userId,
				timestamp: Date.now(),
			});
		} catch {
			// Sender offline
		}
	}

	private async handleEdit(msg: ClientEdit): Promise<void> {
		const userId = await this.getUserId();
		const recipientStub = this.env.USER_GATEWAY.get(
			this.env.USER_GATEWAY.idFromName(msg.receiverId),
		);
		try {
			await recipientStub.relayEdit({
				type: "edit",
				messageId: msg.messageId,
				matchId: msg.matchId,
				senderId: userId,
				content: msg.content,
				timestamp: Date.now(),
			});
		} catch {
			// Recipient offline
		}
	}

	private async handleDelete(msg: ClientDelete): Promise<void> {
		const userId = await this.getUserId();
		const recipientStub = this.env.USER_GATEWAY.get(
			this.env.USER_GATEWAY.idFromName(msg.receiverId),
		);
		try {
			await recipientStub.relayDelete({
				type: "delete",
				messageId: msg.messageId,
				matchId: msg.matchId,
				senderId: userId,
				timestamp: Date.now(),
			});
		} catch {
			// Recipient offline
		}
	}

	// ── Presence ───────────────────────────────────────────────────────

	private async markOnline(): Promise<void> {
		await this.broadcastPresence(true);
	}

	private async markOffline(): Promise<void> {
		await this.broadcastPresence(false);
	}

	private async broadcastPresence(online: boolean): Promise<void> {
		const userId = await this.getUserId();

		const notifications = Array.from(this.matches.values()).map(
			async (match) => {
				const stub = this.env.USER_GATEWAY.get(
					this.env.USER_GATEWAY.idFromName(match.matchedUserId),
				);
				try {
					await stub.notifyPresence(userId, online);
				} catch {
					// Match's DO unreachable — skip
				}
			},
		);

		await Promise.allSettled(notifications);
	}

	// ── Match Awareness ────────────────────────────────────────────────

	private async loadMatches(): Promise<void> {
		const userId = await this.getUserId();

		const res = await fetch(
			`${this.env.NODE_API_URL}/sys/matches?userId=${encodeURIComponent(userId)}`,
			{
				headers: {
					Authorization: `Bearer ${this.env.NODE_API_KEY}`,
				},
			},
		);

		if (!res.ok) {
			throw new Error(`Failed to load matches: ${res.status}`);
		}

		const data = (await res.json()) as {
			match_id: string;
			matched_user_id: string;
		}[];

		this.matches.clear();
		const list: Match[] = [];

		for (const row of data) {
			const match: Match = {
				matchId: row.match_id,
				matchedUserId: row.matched_user_id,
			};
			this.matches.set(row.match_id, match);
			list.push(match);
		}

		// Cache in DO storage for fast reload after hibernation
		await this.ctx.storage.put("cachedMatches", list);
		this.matchesLoaded = true;
	}

	// ── Validation ─────────────────────────────────────────────────────

	private validateContent(msg: ContentMessage): string | null {
		if (!msg.matchId || !msg.receiverId || msg.seq_no == null) {
			return "Missing required fields: matchId, receiverId, seq_no";
		}

		switch (msg.type) {
			case "text":
				if (!msg.content || msg.content.length > MAX_TEXT_LENGTH) {
					return `Text must be 1-${MAX_TEXT_LENGTH} characters`;
				}
				break;
			case "emoji":
				if (!msg.content) return "Missing emoji content";
				break;
			case "gif":
				try {
					const url = new URL(msg.url);
					if (!url.hostname.endsWith(TENOR_DOMAIN)) {
						return "GIF URL must be from tenor.com";
					}
				} catch {
					return "Invalid GIF URL";
				}
				break;
			case "photo":
				if (!msg.messageId) return "Missing photo messageId";
				break;
			case "voice":
				break;
		}

		return null;
	}

	// ── Rate Limiting ──────────────────────────────────────────────────

	private async checkRateLimit(matchId: string): Promise<boolean> {
		const key = `rate:${matchId}`;
		const now = Date.now();
		const window =
			(await this.ctx.storage.get<RateWindow>(key)) ?? {
				count: 0,
				windowStart: now,
			};

		if (now - window.windowStart > RATE_LIMIT_WINDOW_MS) {
			await this.ctx.storage.put(key, { count: 1, windowStart: now });
			return true;
		}

		if (window.count >= RATE_LIMIT_MAX) {
			return false;
		}

		window.count++;
		await this.ctx.storage.put(key, window);
		return true;
	}

	// ── Internal Helpers ───────────────────────────────────────────────

	/** Restore userId + matches from DO storage after hibernation wake */
	private async ensureState(): Promise<void> {
		if (!this.userId) {
			this.userId =
				(await this.ctx.storage.get<string>("userId")) ?? null;
		}
		if (!this.matchesLoaded) {
			const cached =
				await this.ctx.storage.get<Match[]>("cachedMatches");
			if (cached) {
				for (const m of cached) this.matches.set(m.matchId, m);
			} else {
				await this.loadMatches();
			}
			this.matchesLoaded = true;
		}
	}

	private async getUserId(): Promise<string> {
		if (this.userId) return this.userId;
		this.userId =
			(await this.ctx.storage.get<string>("userId")) ?? "";
		return this.userId;
	}

	private safeSend(
		ws: WebSocket,
		data: ServerMessage | Record<string, unknown>,
	): void {
		try {
			ws.send(JSON.stringify(data));
		} catch {
			// Socket already closed
		}
	}

	private async hashContent(msg: ContentMessage): Promise<string> {
		let raw = "";
		switch (msg.type) {
			case "text":
			case "emoji":
				raw = msg.content;
				break;
			case "gif":
				raw = msg.url;
				break;
			case "photo":
				raw = msg.messageId;
				break;
			case "voice":
				return "";
		}

		const hash = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(raw),
		);
		return Array.from(new Uint8Array(hash))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	private async generateR2SignedUrl(
		userId: string,
		photoMessageId: string,
	): Promise<string> {
		const r2 = new AwsClient({
			accessKeyId: this.env.R2_ACCESS_KEY_ID,
			secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
			service: "s3",
			region: "auto",
		});

		const key = `photos/${userId}/${photoMessageId}`;
		const bucket = `https://${this.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${this.env.R2_BUCKET_NAME}`;
		const url = new URL(`${bucket}/${key}`);
		url.searchParams.set("X-Amz-Expires", "86400");

		const signed = await r2.sign(url.toString(), {
			method: "GET",
			aws: { signQuery: true },
		});

		return signed.url;
	}
}
