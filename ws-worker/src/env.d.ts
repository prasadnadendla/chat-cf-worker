// Secrets set via `wrangler secret put <NAME>` — not in wrangler.jsonc
declare namespace Cloudflare {
	interface Env {
		// JWT
		JWT_PUBLIC_KEY: string;

		// R2 presigned URLs (S3-compatible API credentials)
		R2_ACCESS_KEY_ID: string;
		R2_SECRET_ACCESS_KEY: string;
		R2_ACCOUNT_ID: string;

		// TURN server (Cloudflare TURN API)
		TURN_TOKEN: string;
		TURN_API_TOKEN: string;

		// Node.js internal API (FCM dispatch)
		NODE_API_KEY: string;
	}
}
