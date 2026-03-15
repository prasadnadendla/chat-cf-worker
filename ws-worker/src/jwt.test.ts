import { describe, it, expect, beforeAll } from "vitest";
import { verifyJWT, base64UrlToBytes, pemToBuffer } from "./jwt";

// ── Helpers to generate test JWTs ────────────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodePayload(obj: Record<string, unknown>): string {
	return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signES256(
	data: string,
	privateKey: CryptoKey,
): Promise<string> {
	const sig = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		privateKey,
		new TextEncoder().encode(data),
	);
	return bytesToBase64Url(new Uint8Array(sig));
}

async function signRS256(
	data: string,
	privateKey: CryptoKey,
): Promise<string> {
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		privateKey,
		new TextEncoder().encode(data),
	);
	return bytesToBase64Url(new Uint8Array(sig));
}

function arrayBufferToPem(buffer: ArrayBuffer, label: string): string {
	const bytes = new Uint8Array(buffer);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	const b64 = btoa(bin);
	const lines = b64.match(/.{1,64}/g)!.join("\n");
	return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function buildToken(
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
	signFn: (data: string, key: CryptoKey) => Promise<string>,
	privateKey: CryptoKey,
): Promise<string> {
	const headerB64 = encodePayload(header);
	const payloadB64 = encodePayload(payload);
	const sigB64 = await signFn(`${headerB64}.${payloadB64}`, privateKey);
	return `${headerB64}.${payloadB64}.${sigB64}`;
}

// ── Test Suite ────────────────────────────────────────────────────────

const ISSUER = "auth.genzyy.in";
const AUDIENCE = "genzyy-app";

describe("base64UrlToBytes", () => {
	it("decodes standard base64url strings", () => {
		const input = btoa("hello world")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const result = base64UrlToBytes(input);
		expect(new TextDecoder().decode(result)).toBe("hello world");
	});

	it("handles padding correctly", () => {
		// "a" encodes to "YQ" (no padding in base64url)
		const result = base64UrlToBytes("YQ");
		expect(new TextDecoder().decode(result)).toBe("a");
	});
});

describe("pemToBuffer", () => {
	it("strips PEM headers and decodes base64", () => {
		const pem =
			"-----BEGIN PUBLIC KEY-----\nTUVTU0FHRQ==\n-----END PUBLIC KEY-----";
		const buf = pemToBuffer(pem);
		const decoded = new TextDecoder().decode(new Uint8Array(buf));
		expect(decoded).toBe("MESSAGE");
	});
});

describe("verifyJWT — ES256", () => {
	let publicKeyPem: string;
	let privateKey: CryptoKey;

	beforeAll(async () => {
		const keyPair = await crypto.subtle.generateKey(
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["sign", "verify"],
		);
		privateKey = keyPair.privateKey;
		const pubBuf = await crypto.subtle.exportKey("spki", keyPair.publicKey);
		publicKeyPem = arrayBufferToPem(pubBuf, "PUBLIC KEY");
	});

	it("verifies a valid ES256 token", async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await buildToken(
			{ alg: "ES256", typ: "JWT" },
			{
				sub: "user-123",
				userId: "user-123",
				exp: now + 3600,
				iss: ISSUER,
				aud: AUDIENCE,
			},
			signES256,
			privateKey,
		);

		const payload = await verifyJWT(token, publicKeyPem, ISSUER, AUDIENCE);
		expect(payload.sub).toBe("user-123");
		expect(payload.userId).toBe("user-123");
		expect(payload.iss).toBe(ISSUER);
		expect(payload.aud).toBe(AUDIENCE);
	});

	it("rejects an expired token", async () => {
		const token = await buildToken(
			{ alg: "ES256", typ: "JWT" },
			{
				sub: "user-123",
				userId: "user-123",
				exp: Math.floor(Date.now() / 1000) - 60,
				iss: ISSUER,
				aud: AUDIENCE,
			},
			signES256,
			privateKey,
		);

		await expect(
			verifyJWT(token, publicKeyPem, ISSUER, AUDIENCE),
		).rejects.toThrow("Token expired");
	});

	it("rejects wrong issuer", async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await buildToken(
			{ alg: "ES256", typ: "JWT" },
			{
				sub: "user-123",
				userId: "user-123",
				exp: now + 3600,
				iss: "wrong-issuer",
				aud: AUDIENCE,
			},
			signES256,
			privateKey,
		);

		await expect(
			verifyJWT(token, publicKeyPem, ISSUER, AUDIENCE),
		).rejects.toThrow("Invalid issuer");
	});

	it("rejects wrong audience", async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await buildToken(
			{ alg: "ES256", typ: "JWT" },
			{
				sub: "user-123",
				userId: "user-123",
				exp: now + 3600,
				iss: ISSUER,
				aud: "wrong-audience",
			},
			signES256,
			privateKey,
		);

		await expect(
			verifyJWT(token, publicKeyPem, ISSUER, AUDIENCE),
		).rejects.toThrow("Invalid audience");
	});

	it("rejects a tampered payload", async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await buildToken(
			{ alg: "ES256", typ: "JWT" },
			{
				sub: "user-123",
				userId: "user-123",
				exp: now + 3600,
				iss: ISSUER,
				aud: AUDIENCE,
			},
			signES256,
			privateKey,
		);

		// Tamper with the payload portion
		const parts = token.split(".");
		const tamperedPayload = encodePayload({
			sub: "attacker",
			userId: "attacker",
			exp: now + 3600,
			iss: ISSUER,
			aud: AUDIENCE,
		});
		const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

		await expect(
			verifyJWT(tampered, publicKeyPem, ISSUER, AUDIENCE),
		).rejects.toThrow("Invalid signature");
	});

	it("rejects token signed with a different key", async () => {
		const otherKeyPair = await crypto.subtle.generateKey(
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["sign", "verify"],
		);

		const now = Math.floor(Date.now() / 1000);
		const token = await buildToken(
			{ alg: "ES256", typ: "JWT" },
			{
				sub: "user-123",
				userId: "user-123",
				exp: now + 3600,
				iss: ISSUER,
				aud: AUDIENCE,
			},
			signES256,
			otherKeyPair.privateKey,
		);

		await expect(
			verifyJWT(token, publicKeyPem, ISSUER, AUDIENCE),
		).rejects.toThrow("Invalid signature");
	});
});

describe("verifyJWT — RS256", () => {
	let publicKeyPem: string;
	let privateKey: CryptoKey;

	beforeAll(async () => {
		const keyPair = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		privateKey = keyPair.privateKey;
		const pubBuf = await crypto.subtle.exportKey("spki", keyPair.publicKey);
		publicKeyPem = arrayBufferToPem(pubBuf, "PUBLIC KEY");
	});

	it("verifies a valid RS256 token", async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await buildToken(
			{ alg: "RS256", typ: "JWT" },
			{
				sub: "user-456",
				userId: "user-456",
				exp: now + 3600,
				iss: ISSUER,
				aud: AUDIENCE,
			},
			signRS256,
			privateKey,
		);

		const payload = await verifyJWT(token, publicKeyPem, ISSUER, AUDIENCE);
		expect(payload.sub).toBe("user-456");
		expect(payload.userId).toBe("user-456");
	});

	it("rejects an expired RS256 token", async () => {
		const token = await buildToken(
			{ alg: "RS256", typ: "JWT" },
			{
				sub: "user-456",
				userId: "user-456",
				exp: Math.floor(Date.now() / 1000) - 60,
				iss: ISSUER,
				aud: AUDIENCE,
			},
			signRS256,
			privateKey,
		);

		await expect(
			verifyJWT(token, publicKeyPem, ISSUER, AUDIENCE),
		).rejects.toThrow("Token expired");
	});
});

describe("verifyJWT — edge cases", () => {
	it("rejects malformed token (missing parts)", async () => {
		await expect(
			verifyJWT("only.two", "fake-pem", ISSUER, AUDIENCE),
		).rejects.toThrow("Invalid token format");
	});

	it("rejects single-segment token", async () => {
		await expect(
			verifyJWT("singletoken", "fake-pem", ISSUER, AUDIENCE),
		).rejects.toThrow("Invalid token format");
	});

	it("rejects unsupported algorithm", async () => {
		// Generate a real key to provide a valid PEM (algorithm check happens after PEM parsing)
		const keyPair = await crypto.subtle.generateKey(
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["sign", "verify"],
		);
		const pubBuf = await crypto.subtle.exportKey("spki", keyPair.publicKey);
		const pem = arrayBufferToPem(pubBuf, "PUBLIC KEY");

		const header = encodePayload({ alg: "HS256", typ: "JWT" });
		const payload = encodePayload({
			sub: "user",
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		const fakeSig = bytesToBase64Url(new Uint8Array(64));
		const fakeToken = `${header}.${payload}.${fakeSig}`;

		await expect(
			verifyJWT(fakeToken, pem, ISSUER, AUDIENCE),
		).rejects.toThrow("Unsupported algorithm: HS256");
	});

	it("accepts token without exp when exp is 0/falsy", async () => {
		// Generate a key pair for signing
		const keyPair = await crypto.subtle.generateKey(
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["sign", "verify"],
		);
		const pubBuf = await crypto.subtle.exportKey("spki", keyPair.publicKey);
		const pem = arrayBufferToPem(pubBuf, "PUBLIC KEY");

		const token = await buildToken(
			{ alg: "ES256", typ: "JWT" },
			{
				sub: "user-789",
				userId: "user-789",
				exp: 0,
				iss: ISSUER,
				aud: AUDIENCE,
			},
			signES256,
			keyPair.privateKey,
		);

		// exp=0 is falsy, so the check `if (payload.exp && ...)` skips it
		const payload = await verifyJWT(token, pem, ISSUER, AUDIENCE);
		expect(payload.sub).toBe("user-789");
	});
});
