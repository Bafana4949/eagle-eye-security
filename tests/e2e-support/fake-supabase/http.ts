/**
 * E2E TEST SUPPORT ONLY: small HTTP helpers for the fake Supabase server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 12 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {}
  ) {
    super(typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : `HTTP ${status}`);
  }
}

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > limit) {
      throw new HttpError(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null });
  }
}

/** JSON.stringify that survives bigint and binary values coming back from PGlite. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
    return v;
  });
}

export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const requested = req.headers['access-control-request-headers'];
  return {
    'Access-Control-Allow-Origin': typeof req.headers.origin === 'string' ? req.headers.origin : '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      typeof requested === 'string' && requested
        ? requested
        : 'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, range-unit, x-client-info, x-supabase-api-version, x-upsert, cache-control, x-retry-count, x-metadata',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Location, Location, X-Supabase-Api-Version, Preference-Applied, Retry-After',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
}

export function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent || res.destroyed) return;
  const all: Record<string, string> = { ...corsHeaders(req), ...headers };
  let payload: Buffer | null = null;
  if (body === undefined || body === null || status === 204 || status === 304) {
    payload = null;
  } else if (Buffer.isBuffer(body)) {
    payload = body;
  } else if (typeof body === 'string' && all['Content-Type']) {
    payload = Buffer.from(body, 'utf8');
  } else {
    payload = Buffer.from(toJson(body), 'utf8');
    if (!all['Content-Type']) all['Content-Type'] = 'application/json; charset=utf-8';
  }
  if (payload && req.method !== 'HEAD') all['Content-Length'] = String(payload.length);
  res.writeHead(status, all);
  res.end(req.method === 'HEAD' || !payload ? undefined : payload);
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  return null;
}

export function apiKey(req: IncomingMessage): string | null {
  const key = req.headers.apikey;
  return typeof key === 'string' && key ? key : null;
}

/** First value of a header (node joins repeated headers with ', ' except set-cookie). */
export function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
