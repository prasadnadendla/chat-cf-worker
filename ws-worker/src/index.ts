import { AwsClient } from "aws4fetch";
import { type JWTPayload, verifyJWT } from "./jwt";

// Re-export DO class so wrangler can find it from the main entry
export { UserGateway } from "./gateway";

// ── Token Extraction ───────────────────────────────────────────────────

function extractToken(request: Request, url: URL): string | null {
	const auth = request.headers.get("Authorization");
	if (auth?.startsWith("Bearer ")) return auth.slice(7);
	return url.searchParams.get("token");
}

// ── Response Helpers ───────────────────────────────────────────────────

const CORS_HEADERS: HeadersInit = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

async function handleSysDeliver(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth || auth !== `Bearer ${env.SYS_API_KEY}`) {
		return error("Unauthorized", 401);
	}

	const body = await request.json() as {
		targetUserId: string;
		type: "blocked" | "unblocked" | "new_match";
		blockerUserId?: string;
		matchId?: string;
		matchedUserId?: string;
	};

	if (!body.targetUserId || !body.type) {
		return error("Missing required fields", 400);
	}

	const stub = env.USER_GATEWAY.get(env.USER_GATEWAY.idFromName(body.targetUserId));
	if (body.type === "new_match") {
		if (!body.matchId || !body.matchedUserId) return error("Missing matchId or matchedUserId", 400);
		await stub.deliverNewMatch(body.matchId, body.matchedUserId);
	} else if (body.type === "blocked") {
		if (!body.blockerUserId) return error("Missing blockerUserId", 400);
		await stub.deliverBlocked(body.blockerUserId);
	} else {
		if (!body.blockerUserId) return error("Missing blockerUserId", 400);
		await stub.deliverUnblocked(body.blockerUserId);
	}

	return json({ ok: true });
}

async function handleIceConfig(env: Env): Promise<Response> {
	const res = await fetch(
		`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_TOKEN}/credentials/generate-ice-servers`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.TURN_API_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ttl: 86400 }),
		},
	);

	if (!res.ok) {
		return error("Failed to generate ICE servers", 502);
	}

	const iceConfig = await res.json();
	return json(iceConfig);
}

// ── Worker Entry ───────────────────────────────────────────────────────

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		// System endpoint — authenticated by NODE_API_KEY, not user JWT
		if (url.pathname === "/sys/deliver" && request.method === "POST") {
			return handleSysDeliver(request, env);
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

		const userId = payload.userId ?? payload.uid ?? payload.sub;

		// WebSocket upgrade → route to UserGateway DO
		// Chat permission enforced by DO: messages rejected if matchId not in active matches
		if (request.headers.get("Upgrade") === "websocket") {
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
