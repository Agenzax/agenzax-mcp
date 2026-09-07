/**
 * Pairing secret (PSK) for multi-device backfill (Agenzax_E2E_멀티키_설계.md §6, ported from the
 * main Agenzax repo's src/lib/crypto/pairing.ts). Agenzax's server never sees or stores this value
 * — it's generated locally by whichever key holder already has conversation history, and used to
 * verify (locally, offline) that a new device asking for backfill is really authorized by the same
 * company, not an attacker who merely knows the listing id.
 */
async function hmacKey(psk: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode(psk), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function generatePairingSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signaturePayload(publicKeyBase64: string, timestamp: number): ArrayBuffer {
  const u8 = new TextEncoder().encode(`${publicKeyBase64}.${timestamp}`);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export async function signBackfillRequest(psk: string, publicKeyBase64: string, timestamp: number): Promise<string> {
  const key = await hmacKey(psk);
  const sig = await crypto.subtle.sign("HMAC", key, signaturePayload(publicKeyBase64, timestamp));
  return Buffer.from(sig).toString("base64");
}

export async function verifyBackfillRequest(psk: string, publicKeyBase64: string, timestamp: number, signatureBase64: string): Promise<boolean> {
  const key = await hmacKey(psk);
  const sigBytes = Buffer.from(signatureBase64, "base64");
  return crypto.subtle.verify("HMAC", key, sigBytes, signaturePayload(publicKeyBase64, timestamp));
}
