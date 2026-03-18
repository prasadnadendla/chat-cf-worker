// ── Client → Server Messages ───────────────────────────────────────────

export interface BaseClientMessage {
	matchId: string;
	seq_no: number;
}

export interface TextMessage extends BaseClientMessage {
	type: "text";
	content: string;
}

export interface EmojiMessage extends BaseClientMessage {
	type: "emoji";
	content: string;
}

export interface GifMessage extends BaseClientMessage {
	type: "gif";
	url: string;
}

export interface PhotoMessage extends BaseClientMessage {
	type: "photo";
	messageId: string;
	blurHash?: string;
	url: string;
	viewLimit?: number;
}

export interface VoiceMessage extends BaseClientMessage {
	type: "voice";
}

export type ContentMessage =
	| TextMessage
	| EmojiMessage
	| GifMessage
	| PhotoMessage
	| VoiceMessage;

export type ContentType = ContentMessage["type"];

export interface RTCSignal {
	type: "rtc_offer" | "rtc_answer" | "rtc_ice" | "rtc_failed";
	matchId: string;
	payload: unknown;
}

export interface ClientAck {
	type: "ack";
	messageId: string;
	matchId: string;
}

export interface ClientReadAck {
	type: "read";
	messageId: string;
	matchId: string;
}

export interface ClientEdit {
	type: "edit";
	messageId: string;
	matchId: string;
	content: string;
}

export interface ClientDelete {
	type: "delete";
	messageId: string;
	matchId: string;
}

export interface ClientPong {
	type: "pong";
}

export interface RefreshMatchesRequest {
	type: "refresh_matches";
}

export interface QueryPresenceRequest {
	type: "query_presence";
	userId: string;
}

export type ClientMessage =
	| ContentMessage
	| RTCSignal
	| ClientAck
	| ClientReadAck
	| ClientEdit
	| ClientDelete
	| ClientPong
	| RefreshMatchesRequest
	| QueryPresenceRequest;

// ── Server → Client Messages ───────────────────────────────────────────

export interface ServerDelivery {
	type: "message";
	messageId: string;
	matchId: string;
	senderId: string;
	messageType: ContentType;
	content?: string;
	url?: string;
	timestamp: number;
	viewLimit?: number;
}

export interface ServerAck {
	type: "ack";
	messageId: string;
	seq_no: number;
	timestamp: number;
}

export interface PresenceEvent {
	type: "presence";
	userId: string;
	online: boolean;
}

export interface UnmatchEvent {
	type: "unmatch";
	matchId: string;
}

export interface VoiceReadyEvent {
	type: "voice_ready";
	matchId: string;
	senderId: string;
	messageId: string;
}

export interface ServerPing {
	type: "ping";
}

export interface ServerError {
	type: "error";
	message: string;
	seq_no?: number;
}

export interface ServerReadAck {
	type: "read";
	messageId: string;
	senderId: string;
	timestamp: number;
}

export interface ServerEdit {
	type: "edit";
	messageId: string;
	matchId: string;
	senderId: string;
	content: string;
	timestamp: number;
}

export interface ServerDelete {
	type: "delete";
	messageId: string;
	matchId: string;
	senderId: string;
	timestamp: number;
}

/** RTC signal relayed to recipient — server adds senderId so recipient knows who sent it */
export interface RelayedSignal {
	type: "rtc_offer" | "rtc_answer" | "rtc_ice" | "rtc_failed";
	matchId: string;
	senderId: string;
	payload: unknown;
}

export interface BlockedEvent {
	type: "blocked";
	blockerUserId: string;
}

export interface UnblockedEvent {
	type: "unblocked";
	blockerUserId: string;
}

export interface NewMatchEvent {
	type: "new_match";
	matchId: string;
}

export type ServerMessage =
	| ServerDelivery
	| ServerAck
	| ServerReadAck
	| ServerEdit
	| ServerDelete
	| PresenceEvent
	| UnmatchEvent
	| VoiceReadyEvent
	| ServerPing
	| ServerError
	| RelayedSignal
	| BlockedEvent
	| UnblockedEvent
	| NewMatchEvent;

// ── Domain ─────────────────────────────────────────────────────────────

export interface Match {
	matchId: string;
	matchedUserId: string;
}

export interface RateWindow {
	count: number;
	windowStart: number;
}
