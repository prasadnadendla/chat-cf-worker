// ── JWT Utilities ──────────────────────────────────────────────────────

export interface JWTPayload {
	sub: string;
	userId: string;
	uid: string;
	exp: number;
	iss: string;
	aud: string;
}

export function base64UrlToBytes(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const bin = atob(padded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

export function pemToBuffer(pem: string): ArrayBuffer {
	const b64 = pem
		.replace(/-----BEGIN PUBLIC KEY-----/, "")
		.replace(/-----END PUBLIC KEY-----/, "")
		.replace(/\s+/g, "");
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes.buffer;
}

export async function verifyJWT(
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
	let cryptoKey: CryptoKey;
	let valid: boolean;
	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const sig = base64UrlToBytes(signatureB64);

	if (header.alg === "ES256") {
		cryptoKey = await crypto.subtle.importKey(
			"spki",
			pemToBuffer(publicKeyPem),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		valid = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			cryptoKey,
			sig,
			data,
		);
	} else if (header.alg === "RS256") {
		cryptoKey = await crypto.subtle.importKey(
			"spki",
			pemToBuffer(publicKeyPem),
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		valid = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			cryptoKey,
			sig,
			data,
		);
	} else {
		throw new Error(`Unsupported algorithm: ${header.alg}`);
	}
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
