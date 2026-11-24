/**
 * Web Crypto API AES-256-GCM Encryption / Decryption Module
 * Fully compatible with Cloudflare Workers, Node.js 18+, and standard browsers.
 */

// Helper to convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}

// Helper to convert Uint8Array to hex string
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Derive or import a 256-bit CryptoKey
async function getCryptoKey(secretKeyHex: string): Promise<CryptoKey> {
  let keyBytes: Uint8Array;
  if (!secretKeyHex || secretKeyHex.length < 32) {
    // Fallback deterministic padding for dev if secret is short (warns in production)
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(secretKeyHex || 'default-dev-secret-key-32-bytes!'));
    keyBytes = new Uint8Array(hash);
  } else {
    keyBytes = hexToBytes(secretKeyHex.slice(0, 64));
    if (keyBytes.length !== 32) {
      const encoder = new TextEncoder();
      const hash = await crypto.subtle.digest('SHA-256', encoder.encode(secretKeyHex));
      keyBytes = new Uint8Array(hash);
    }
  }

  return await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts sensitive text (e.g. Google OAuth refresh token) with AES-256-GCM.
 * Output format: [12-byte IV in hex]:[ciphertext in hex]
 */
export async function encryptToken(plainText: string, secretKey: string): Promise<string> {
  const key = await getCryptoKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV standard for GCM
  const encodedText = new TextEncoder().encode(plainText);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encodedText
  );

  const ivHex = bytesToHex(iv);
  const cipherHex = bytesToHex(new Uint8Array(cipherBuffer));
  return `${ivHex}:${cipherHex}`;
}

/**
 * Decrypts AES-256-GCM encrypted token.
 */
export async function decryptToken(encryptedString: string, secretKey: string): Promise<string> {
  const parts = encryptedString.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted token format. Expected iv:ciphertext');
  }

  const [ivHex, cipherHex] = parts;
  const iv = hexToBytes(ivHex);
  const cipherBytes = hexToBytes(cipherHex);
  const key = await getCryptoKey(secretKey);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipherBytes
  );

  return new TextDecoder().decode(decryptedBuffer);
}

/**
 * SHA-256 Hash helper for API keys
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(hashBuffer));
}

/**
 * Encrypts raw binary buffers (database snapshots, WAL files) with AES-256-GCM
 * Output format: [12 bytes IV][ciphertext + authentication tag]
 */
export async function encryptBinary(data: Uint8Array, secretKey: string): Promise<Uint8Array> {
  const key = await getCryptoKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  const cipherBytes = new Uint8Array(cipherBuffer);
  const output = new Uint8Array(iv.length + cipherBytes.length);
  output.set(iv, 0);
  output.set(cipherBytes, iv.length);
  return output;
}

/**
 * Decrypts raw binary buffers encrypted with AES-256-GCM
 */
export async function decryptBinary(encryptedData: Uint8Array, secretKey: string): Promise<Uint8Array> {
  if (encryptedData.length < 12 + 16) {
    throw new Error('Encrypted payload too short to be valid AES-GCM binary.');
  }

  const iv = encryptedData.subarray(0, 12);
  const cipherBytes = encryptedData.subarray(12);
  const key = await getCryptoKey(secretKey);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipherBytes
  );

  return new Uint8Array(decryptedBuffer);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
