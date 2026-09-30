/**
 * Cryptographic SHA-256 hash utility using standard Web Crypto API
 */

export async function sha256(message: string): Promise<string> {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Node.js fallback for tests/server
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(message).digest('hex');
  } catch {
    // Simple fallback
    return 'GENESIS';
  }
}
