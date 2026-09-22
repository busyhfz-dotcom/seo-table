/**
 * All cryptography in one place, using only node:crypto — no native addons.
 *
 * - Connector credentials: AES-256-GCM with a random IV per record. The
 *   ciphertext, IV and auth tag are stored in separate columns; nothing is ever
 *   returned by an API response or written to a log.
 * - Passwords: scrypt with a per-user salt, compared in constant time.
 * - Session and API-key tokens: a random 32-byte secret shown once, with only
 *   its SHA-256 stored.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { env } from "./env.js";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

export type SealedSecret = { cipher: string; iv: string; tag: string };

function key(): Buffer {
  return Buffer.from(env().ENCRYPTION_KEY, "hex");
}

export function seal(plaintext: string): SealedSecret {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const cipher = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return {
    cipher: cipher.toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
  };
}

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export function unseal(s: SealedSecret): string {
  const iv = Buffer.from(s.iv, "base64");
  const tag = Buffer.from(s.tag, "base64");
  // GCM accepts truncated tags unless told otherwise, and a short tag is far
  // easier to forge. Only what `seal` produces is accepted.
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new Error("Sealed secret is malformed");
  }
  const d = createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: GCM_TAG_BYTES });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(Buffer.from(s.cipher, "base64")), d.final()]).toString("utf8");
}

export function sealJson(value: unknown): SealedSecret {
  return seal(JSON.stringify(value));
}

export function unsealJson<T>(s: SealedSecret): T {
  return JSON.parse(unseal(s)) as T;
}

// ---------------------------------------------------------------- passwords

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error("Password must be at least 10 characters");
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseScryptHash(stored);
  // A malformed hash still costs one derivation, so login timing does not tell
  // an unknown account (the caller passes a placeholder hash) from a known one.
  const derived = await scrypt(password, parsed?.salt ?? Buffer.alloc(SCRYPT_SALT_BYTES), SCRYPT_KEYLEN);
  return parsed !== null && timingSafeEqual(derived, parsed.expected);
}

/**
 * Strict parse of `scrypt$1$<salt>$<hash>`. The key length used to be taken from
 * the stored hash, so an empty one (`scrypt$1$x$`) matched every password.
 */
function parseScryptHash(stored: string): { salt: Buffer; expected: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "1") return null;
  const [, , saltB64, hashB64] = parts as [string, string, string, string];
  if (!BASE64.test(saltB64) || !BASE64.test(hashB64)) return null;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (salt.length !== SCRYPT_SALT_BYTES || expected.length !== SCRYPT_KEYLEN) return null;
  return { salt, expected };
}

// ---------------------------------------------------------------- tokens

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable fingerprint for an issue: same inputs always produce the same id. */
export function fingerprint(parts: Array<string | number | null | undefined>): string {
  return sha256(parts.map((p) => String(p ?? "")).join("\u0000")).slice(0, 32);
}
