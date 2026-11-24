import { sign, verify } from 'hono/jwt';
import type { Env, JwtUserPayload } from './types';

// Cloudflare Workers Web Crypto supports up to 100,000 PBKDF2 iterations.
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    HASH_BITS
  );

  const hashBytes = new Uint8Array(derivedBits);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(hashBytes)}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations <= 0 || iterations > PBKDF2_ITERATIONS) {
    return false;
  }

  const salt = hexToBytes(parts[2]);
  const expected = hexToBytes(parts[3]);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    expected.length * 8
  );

  return constantTimeEqual(new Uint8Array(derivedBits), expected);
}

export function getJwtSecret(env: Env): string {
  // For production, ALWAYS set JWT_SECRET via `wrangler secret put JWT_SECRET`.
  return env.JWT_SECRET || 'dev-only-insecure-secret-replace-in-production';
}

export async function createAdminToken(
  env: Env,
  user: { id: string; username: string; role: 'admin' }
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: JwtUserPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    exp: nowSeconds + 60 * 60 * 24 * 7, // 7 days
  };

  return sign(payload, getJwtSecret(env), 'HS256');
}

export async function verifyAdminToken(env: Env, token: string): Promise<JwtUserPayload | null> {
  try {
    const verified = await verify(token, getJwtSecret(env), 'HS256');
    if (
      typeof verified.sub === 'string' &&
      typeof verified.username === 'string' &&
      verified.role === 'admin' &&
      typeof verified.exp === 'number'
    ) {
      return {
        sub: verified.sub,
        username: verified.username,
        role: 'admin',
        exp: verified.exp,
      };
    }
    return null;
  } catch {
    return null;
  }
}
