/**
 * SHA-256 helpers on the standard Web Crypto API (browsers in a secure context, Node 20+).
 * There is deliberately no fallback: a hash chain built from a constant is worse than none,
 * so every function throws when crypto.subtle is unavailable (e.g. the page is served over http).
 */

function getSubtle(): SubtleCrypto {
  const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : undefined;
  if (!subtle) {
    throw new Error(
      'Web Crypto (crypto.subtle) is unavailable. The app must be opened over https (or localhost) to record tamper-evident events.'
    );
  }
  return subtle;
}

async function sha256Bytes(message: string): Promise<Uint8Array> {
  const digest = await getSubtle().digest('SHA-256', new TextEncoder().encode(message));
  return new Uint8Array(digest);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Lower-case hex SHA-256 of the UTF-8 encoding of `message`. */
export async function sha256(message: string): Promise<string> {
  return toHex(await sha256Bytes(message));
}

/**
 * Deterministic JSON: object keys sorted (recursively), `undefined` members dropped, no whitespace.
 * Non-finite numbers are rejected because JSON cannot represent them unambiguously.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry))).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/**
 * Stable UUID-formatted id derived from `name` (first 16 bytes of SHA-256, version nibble 8,
 * RFC 4122 variant). Used for idempotent child rows such as incident_media.
 */
export async function uuidFromName(name: string): Promise<string> {
  const bytes = (await sha256Bytes(name)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
