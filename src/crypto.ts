/**
 * Agenzax E2E crypto, reimplemented natively for Node (WebCrypto via globalThis.crypto.subtle —
 * no browser polyfill). Deliberately mirrors the algorithm choices documented in the Agenzax
 * technical spec (4.2) so ciphertext produced here interoperates with the Agenzax web UI and any
 * other client following the same protocol: RSA-OAEP-2048 for identity keys (wraps/unwraps the
 * per-session symmetric key), AES-256-GCM for the session key itself (encrypts message bodies).
 * The server only ever sees ciphertext + wrapped keys — private keys never leave this process.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { bufferToBase64, base64ToBuffer } from "./binary.js";

const RSA_ALG = { name: "RSA-OAEP", hash: "SHA-256" } as const;
const AES_ALG = "AES-GCM";

function keyPath(stateDir: string, listingId: string): string {
  return join(stateDir, `identity-key-${listingId}.pkcs8.b64`);
}

/** Loads this listing's identity private key from disk, generating+persisting a new one on first use. */
export async function loadOrCreateIdentityKey(
  stateDir: string,
  listingId: string
): Promise<{ privateKey: CryptoKey; publicKeySpki: ArrayBuffer | null }> {
  const path = keyPath(stateDir, listingId);
  if (existsSync(path)) {
    const pkcs8 = base64ToBuffer(readFileSync(path, "utf8"));
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, RSA_ALG, false, ["decrypt"]);
    return { privateKey, publicKeySpki: null };
  }
  const pair = await crypto.subtle.generateKey({ ...RSA_ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, [
    "encrypt",
    "decrypt",
  ]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  writeFileSync(path, bufferToBase64(pkcs8));
  const publicKeySpki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return { privateKey: pair.privateKey, publicKeySpki };
}

/** Recovers this listing's own public key (SPKI) from the stored private key — RSA private keys carry n/e. */
export async function derivePublicKey(stateDir: string, listingId: string): Promise<ArrayBuffer> {
  const path = keyPath(stateDir, listingId);
  if (!existsSync(path)) throw new Error(`No identity key found for listing ${listingId} — call loadOrCreateIdentityKey first.`);
  const pkcs8 = base64ToBuffer(readFileSync(path, "utf8"));
  const extractablePrivateKey = await crypto.subtle.importKey("pkcs8", pkcs8, RSA_ALG, true, ["decrypt"]);
  const jwk = await crypto.subtle.exportKey("jwk", extractablePrivateKey);
  const publicJwk: JsonWebKey = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, ext: true };
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, RSA_ALG, true, ["encrypt"]);
  return crypto.subtle.exportKey("spki", publicKey);
}

export async function importPublicKey(spki: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", spki, RSA_ALG, true, ["encrypt"]);
}

export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: AES_ALG, length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function wrapSessionKeyForRecipient(sessionKey: CryptoKey, recipientPublicKey: CryptoKey): Promise<ArrayBuffer> {
  const raw = await crypto.subtle.exportKey("raw", sessionKey);
  return crypto.subtle.encrypt(RSA_ALG, recipientPublicKey, raw);
}

export async function unwrapSessionKey(encryptedSessionKey: ArrayBuffer, myPrivateKey: CryptoKey): Promise<CryptoKey> {
  const raw = await crypto.subtle.decrypt(RSA_ALG, myPrivateKey, encryptedSessionKey);
  return crypto.subtle.importKey("raw", raw, AES_ALG, false, ["encrypt", "decrypt"]);
}

/**
 * Same as unwrapSessionKey but extractable — only the backfill responder needs this (it has to
 * re-export the raw key bytes to re-wrap them for a new device's public key). Never use this for
 * normal message decryption; it needlessly widens the key's exposure surface.
 */
export async function unwrapSessionKeyExtractable(encryptedSessionKey: ArrayBuffer, myPrivateKey: CryptoKey): Promise<CryptoKey> {
  const raw = await crypto.subtle.decrypt(RSA_ALG, myPrivateKey, encryptedSessionKey);
  return crypto.subtle.importKey("raw", raw, AES_ALG, true, ["encrypt", "decrypt"]);
}

export async function encryptMessage(sessionKey: CryptoKey, plaintext: string): Promise<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: AES_ALG, iv }, sessionKey, encoded);
  return { ciphertext, iv: iv.buffer };
}

/** Throws (GCM auth tag check fails) on the wrong key rather than silently returning garbage. */
export async function decryptMessage(sessionKey: CryptoKey, ciphertext: ArrayBuffer, iv: ArrayBuffer): Promise<string> {
  const plainBuf = await crypto.subtle.decrypt({ name: AES_ALG, iv: new Uint8Array(iv) }, sessionKey, ciphertext);
  return new TextDecoder().decode(plainBuf);
}
