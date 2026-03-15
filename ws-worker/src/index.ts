import { AwsClient } from "aws4fetch";

// Re-export DO class so wrangler can find it from the main entry
export { UserGateway } from "./gateway";

// ── JWT Utilities ──────────────────────────────────────────────────────

interface JWTPayload {
	sub: string;
	userId: string;
	exp: number;
	iss: string;
	aud: string;
}

function base64UrlToBytes(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const bin = atob(padded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function pemToBuffer(pem: string): ArrayBuffer {
	const b64 = pem
		.replace(/-----BEGIN PUBLIC KEY-----/, "")
		.replace(/-----END PUBLIC KEY-----/, "")
		.replace(/\s+/g, "");
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes.buffer;
}

async function verifyJWT(
	token: string,
	publicKeyPem: string,
	issuer: string,
	audience: string,
): Promise<JWTPayload> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid token format");

	const [headerB64, payloadB64, signatureB64] = parts;

	const header = JSON.parse(
		new TextDecoder().decode(base64UrlToBytes(headerB64)),
	);
	if (header.alg !== "RS256") throw new Error("Unsupported algorithm");

	const cryptoKey = await crypto.subtle.importKey(
		"spki",
		pemToBuffer(publicKeyPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);

	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		cryptoKey,
		base64UrlToBytes(signatureB64),
		new TextEncoder().encode(`${headerB64}.${payloadB64}`),
	);
	if (!valid) throw new Error("Invalid signature");

	const payload = JSON.parse(
		new TextDecoder().decode(base64UrlToBytes(payloadB64)),
	) as JWTPayload;

	const now = Math.floor(Date.now() / 1000);
	if (payload.exp && payload.exp < now) throw new Error("Token expired");
	if (issuer && payload.iss !== issuer) throw new Error("Invalid issuer");
	if (audience && payload.aud !== audience) throw new Error("Invalid audience");

	return payload;
}

// ── Token Extraction ───────────────────────────────────────────────────

function extractToken(request: Request, url: URL): string | null {
	const auth = request.headers.get("Authorization");
	if (auth?.startsWith("Bearer ")) return auth.slice(7);
	return url.searchParams.get("token");
}

// ── Response Helpers ───────────────────────────────────────────────────

const CORS_HEADERS: HeadersInit = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

function error(message: string, status: number): Response {
	return json({ error: message }, status);
}

// ── Chat Permission ────────────────────────────────────────────────────

async function checkChatPermission(
	env: Env,
	userId: string,
	targetId: string,
): Promise<boolean> {
	try {
		const res = await fetch(
			`${env.NODE_API_URL}/chat/permitted?userId=${encodeURIComponent(userId)}&targetId=${encodeURIComponent(targetId)}`,
			{
				headers: { Authorization: `Bearer ${env.NODE_API_KEY}` },
			},
		);
		if (!res.ok) return false;
		const data = (await res.json()) as { permitted: boolean };
		return data.permitted;
	} catch {
		return false;
	}
}

// ── Route Handlers ─────────────────────────────────────────────────────

async function handleWebSocket(
	request: Request,
	env: Env,
	userId: string,
): Promise<Response> {
	const id = env.USER_GATEWAY.idFromName(userId);
	const stub = env.USER_GATEWAY.get(id);

	const headers = new Headers(request.headers);
	headers.set("X-Verified-User-Id", userId);

	return stub.fetch(
		new Request(request.url, { method: request.method, headers }),
	);
}

async function handleUploadUrl(env: Env, userId: string): Promise<Response> {
	const messageId = crypto.randomUUID();
	const key = `photos/${userId}/${messageId}`;

	const r2 = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: "s3",
		region: "auto",
	});

	const bucket = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}`;

	const putUrl = new URL(`${bucket}/${key}`);
	putUrl.searchParams.set("X-Amz-Expires", "3600");
	const signedPut = await r2.sign(putUrl.toString(), {
		method: "PUT",
		aws: { signQuery: true },
	});

	const getUrl = new URL(`${bucket}/${key}`);
	getUrl.searchParams.set("X-Amz-Expires", "86400");
	const signedGet = await r2.sign(getUrl.toString(), {
		method: "GET",
		aws: { signQuery: true },
	});

	return json({
		messageId,
		uploadUrl: signedPut.url,
		downloadUrl: signedGet.url,
		expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
	});
}

async function handleDeletePhoto(
	messageId: string,
	env: Env,
	userId: string,
): Promise<Response> {
	const key = `photos/${userId}/${messageId}`;
	await env.PHOTOS_BUCKET.delete(key);
	return json({ deleted: true });
}

function handleIceConfig(env: Env): Response {
	return json({
		iceServers: [
			{
				urls: JSON.parse(env.TURN_URLS),
				username: env.TURN_USERNAME,
				credential: env.TURN_CREDENTIAL,
			},
		],
	});
}

// ── Worker Entry ───────────────────────────────────────────────────────

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const token = extractToken(request, url);
		if (!token) {
			return error("Missing authentication token", 401);
		}

		let payload: JWTPayload;
		try {
			payload = await verifyJWT(
				token,
				env.JWT_PUBLIC_KEY,
				env.JWT_ISSUER,
				env.JWT_AUDIENCE,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Authentication failed";
			return error(msg, 401);
		}

		const userId = payload.userId ?? payload.sub;

		// WebSocket upgrade → verify chat permission, then route to DO
		if (request.headers.get("Upgrade") === "websocket") {
			const targetId = url.searchParams.get("targetId");
			if (targetId) {
				const permitted = await checkChatPermission(env, userId, targetId);
				if (!permitted) {
					return error("Chat not permitted", 403);
				}
			}
			return handleWebSocket(request, env, userId);
		}

		// HTTP API
		if (url.pathname === "/upload-url" && request.method === "GET") {
			return handleUploadUrl(env, userId);
		}

		const photoMatch = url.pathname.match(/^\/photo\/([^/]+)$/);
		if (photoMatch && request.method === "DELETE") {
			return handleDeletePhoto(photoMatch[1], env, userId);
		}

		if (url.pathname === "/ice-config" && request.method === "GET") {
			return handleIceConfig(env);
		}

		return error("Not found", 404);
	},
} satisfies ExportedHandler<Env>;
