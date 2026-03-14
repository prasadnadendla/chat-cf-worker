// Secrets set via `wrangler secret put <NAME>` — not in wrangler.jsonc
declare namespace Cloudflare {
	interface Env {
		JWT_PUBLIC_KEY: string;
		R2_ACCESS_KEY_ID: string;
		R2_SECRET_ACCESS_KEY: string;
		R2_ACCOUNT_ID: string;
		TURN_USERNAME: string;
		TURN_CREDENTIAL: string;
	}
}
