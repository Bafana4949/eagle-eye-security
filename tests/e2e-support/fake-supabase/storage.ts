/**
 * E2E TEST SUPPORT ONLY: the Supabase Storage subset the app uses.
 *
 *   POST /storage/v1/object/<bucket>/<path>            upload (multipart or raw body, x-upsert)
 *   PUT  /storage/v1/object/<bucket>/<path>            update (needs an UPDATE policy)
 *   POST /storage/v1/object/sign/<bucket>/<path>       signed URL ({ expiresIn })
 *   POST /storage/v1/object/sign/<bucket>              signed URLs ({ expiresIn, paths })
 *   GET  /storage/v1/object/sign/<bucket>/<path>?token download through a signed URL
 *   GET  /storage/v1/object/authenticated/<bucket>/<path> download as the caller
 *   DELETE /storage/v1/object/<bucket>  { prefixes }   remove (needs a DELETE policy)
 *   POST /storage/v1/object/list/<bucket>              list ({ prefix, limit, offset })
 *
 * Like the real Storage API the bucket limits (size, MIME types) are checked first, then the
 * object row is written to storage.objects AS THE CALLER, so the RLS policies of the migrations
 * decide. Object bytes live in memory. Error bodies: { statusCode, error, message }.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TEST_JWT_SECRET } from '../constants';
import { signJwt, verifyJwt } from '../jwt';
import { HttpError, header, parseJsonBody, send } from './http';
import type { Caller, FakeSupabaseState } from './state';

function storageError(status: number, error: string, message: string): HttpError {
  return new HttpError(status, { statusCode: String(status), error, message });
}

const NOT_FOUND = () => storageError(404, 'not_found', 'Object not found');

interface BucketRow {
  id: string;
  public: boolean;
  file_size_limit: number | string | null;
  allowed_mime_types: string[] | null;
}

function splitBucketPath(rest: string): { bucket: string; name: string } {
  const segments = rest.split('/').map((s) => decodeURIComponent(s));
  const bucket = segments.shift() ?? '';
  const name = segments.filter((s) => s !== '').join('/');
  if (!bucket) throw storageError(400, 'InvalidRequest', 'Bucket name is required');
  return { bucket, name };
}

function mimeAllowed(allowed: string[] | null, mime: string): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((pattern) => (pattern.endsWith('/*') ? mime.startsWith(pattern.slice(0, -1)) : pattern === mime));
}

async function parseUpload(req: IncomingMessage, body: Buffer): Promise<{ bytes: Buffer; contentType: string; cacheControl: string | null }> {
  const contentType = header(req, 'content-type') ?? 'application/octet-stream';
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData();
    let file: File | null = null;
    for (const value of form.values()) {
      if (typeof value !== 'string') {
        file = value;
        break;
      }
    }
    if (!file) throw storageError(400, 'InvalidRequest', 'No file found in the multipart body');
    const cacheControl = form.get('cacheControl');
    return {
      bytes: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || 'application/octet-stream',
      cacheControl: typeof cacheControl === 'string' ? cacheControl : null
    };
  }
  return { bytes: body, contentType: contentType.split(';')[0].trim(), cacheControl: header(req, 'cache-control') };
}

export class StorageHandler {
  constructor(private readonly state: FakeSupabaseState) {}

  private async bucket(id: string): Promise<BucketRow> {
    const result = await this.state.asSuperuser((db) =>
      db.query<BucketRow>(`SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = $1`, [id])
    );
    const row = result.rows[0];
    if (!row) throw storageError(404, 'Bucket not found', 'Bucket not found');
    return row;
  }

  private request(req: IncomingMessage, url: URL) {
    return { method: req.method ?? 'GET', path: url.pathname, headers: {} as Record<string, string> };
  }

  /** Is the object visible to the caller (storage.objects SELECT policy)? */
  private async visible(caller: Caller, req: IncomingMessage, url: URL, bucket: string, name: string): Promise<boolean> {
    const result = await this.state.runAs(caller, this.request(req, url), (tx) =>
      tx.query(`SELECT 1 FROM storage.objects WHERE bucket_id = $1 AND name = $2`, [bucket, name])
    );
    return result.rows.length > 0;
  }

  private signedPath(bucket: string, name: string, expiresIn: number): string {
    const iat = Math.floor(Date.now() / 1000);
    const token = signJwt({ url: `${bucket}/${name}`, iat, exp: iat + expiresIn }, TEST_JWT_SECRET);
    return `/object/sign/${bucket}/${name}?token=${token}`;
  }

  private serve(req: IncomingMessage, res: ServerResponse, url: URL, bucket: string, name: string): void {
    const object = this.state.objects.get(`${bucket}/${name}`);
    if (!object) throw NOT_FOUND();
    const headers: Record<string, string> = {
      'Content-Type': object.contentType,
      'Cache-Control': 'no-cache',
      ETag: `"${object.bytes.length}-${object.createdAt}"`
    };
    if (url.searchParams.has('download')) {
      const filename = url.searchParams.get('download') || name.split('/').pop() || 'download';
      headers['Content-Disposition'] = `attachment; filename="${filename.replace(/"/g, '')}"`;
    }
    send(req, res, 200, object.bytes, headers);
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, subpath: string, getCaller: () => Caller, body: Buffer): Promise<void> {
    const method = req.method ?? 'GET';

    // Signed download: the token (not the caller) authorises it, as on Supabase.
    const signedGet = /^object\/sign\/(.+)$/.exec(subpath);
    if (signedGet && (method === 'GET' || method === 'HEAD')) {
      const { bucket, name } = splitBucketPath(signedGet[1]);
      const token = url.searchParams.get('token');
      if (!token) throw storageError(400, 'InvalidJWT', 'Missing token');
      const verified = verifyJwt(token, TEST_JWT_SECRET);
      if (!verified.ok) throw storageError(400, 'InvalidJWT', verified.reason === 'expired' ? 'jwt expired' : 'invalid signature');
      if (verified.payload.url !== `${bucket}/${name}`) throw storageError(400, 'InvalidSignature', 'The url do not match the signature');
      return this.serve(req, res, url, bucket, name);
    }

    const caller = getCaller();

    const authenticatedGet = /^object\/(?:authenticated\/)?(.+)$/.exec(subpath);
    if (authenticatedGet && (method === 'GET' || method === 'HEAD') && !subpath.startsWith('object/public/')) {
      const { bucket, name } = splitBucketPath(authenticatedGet[1]);
      if (caller.role !== 'service_role' && !(await this.visible(caller, req, url, bucket, name))) throw NOT_FOUND();
      return this.serve(req, res, url, bucket, name);
    }

    const publicGet = /^object\/public\/(.+)$/.exec(subpath);
    if (publicGet && (method === 'GET' || method === 'HEAD')) {
      const { bucket, name } = splitBucketPath(publicGet[1]);
      const row = await this.bucket(bucket);
      if (!row.public) throw storageError(400, 'InvalidRequest', 'The bucket is not public');
      return this.serve(req, res, url, bucket, name);
    }

    const signBatch = /^object\/sign\/([^/]+)$/.exec(subpath);
    if (signBatch && method === 'POST') {
      const input = (parseJsonBody(body) ?? {}) as { expiresIn?: unknown; paths?: unknown };
      const expiresIn = Number(input.expiresIn);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw storageError(400, 'InvalidRequest', 'expiresIn must be a positive number');
      const bucket = decodeURIComponent(signBatch[1]);
      const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === 'string') : [];
      const out = [];
      for (const name of paths) {
        const ok = caller.role === 'service_role' || (await this.visible(caller, req, url, bucket, name));
        out.push(ok ? { path: name, signedURL: this.signedPath(bucket, name, Math.floor(expiresIn)), error: null } : { path: name, signedURL: null, error: 'Either the object does not exist or you do not have access to it' });
      }
      return send(req, res, 200, out);
    }

    if (signedGet && method === 'POST') {
      const { bucket, name } = splitBucketPath(signedGet[1]);
      const input = (parseJsonBody(body) ?? {}) as { expiresIn?: unknown };
      const expiresIn = Number(input.expiresIn);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw storageError(400, 'InvalidRequest', 'expiresIn must be a positive number');
      await this.bucket(bucket);
      const ok = caller.role === 'service_role' ? this.state.objects.has(`${bucket}/${name}`) : await this.visible(caller, req, url, bucket, name);
      if (!ok) throw NOT_FOUND();
      return send(req, res, 200, { signedURL: this.signedPath(bucket, name, Math.floor(expiresIn)) });
    }

    const list = /^object\/list\/([^/]+)$/.exec(subpath);
    if (list && method === 'POST') {
      const input = (parseJsonBody(body) ?? {}) as { prefix?: unknown; limit?: unknown; offset?: unknown };
      const bucket = decodeURIComponent(list[1]);
      const prefix = typeof input.prefix === 'string' ? input.prefix.replace(/^\/+|\/+$/g, '') : '';
      const limit = Number.isInteger(input.limit) ? Number(input.limit) : 100;
      const offset = Number.isInteger(input.offset) ? Number(input.offset) : 0;
      const rows = await this.state.runAs(caller, this.request(req, url), (tx) =>
        tx.query<{ id: string; name: string; created_at: string; updated_at: string; metadata: unknown }>(
          `SELECT id, name, created_at, updated_at, metadata FROM storage.objects
            WHERE bucket_id = $1 AND ($2 = '' OR name LIKE $2 || '/%') ORDER BY name`,
          [bucket, prefix]
        )
      );
      const seen = new Set<string>();
      const entries: unknown[] = [];
      for (const row of rows.rows) {
        const rest = prefix ? row.name.slice(prefix.length + 1) : row.name;
        const [first, ...more] = rest.split('/');
        if (more.length > 0) {
          if (!seen.has(first)) {
            seen.add(first);
            entries.push({ name: first, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null });
          }
        } else {
          entries.push({ name: first, id: row.id, updated_at: row.updated_at, created_at: row.created_at, last_accessed_at: row.updated_at, metadata: row.metadata });
        }
      }
      return send(req, res, 200, entries.slice(offset, offset + limit));
    }

    const removeMatch = /^object\/([^/]+)\/?$/.exec(subpath);
    if (removeMatch && method === 'DELETE') {
      const bucket = decodeURIComponent(removeMatch[1]);
      const input = (parseJsonBody(body) ?? {}) as { prefixes?: unknown };
      const names = Array.isArray(input.prefixes) ? input.prefixes.filter((p): p is string => typeof p === 'string') : [];
      const deleted = await this.state.runAs(caller, this.request(req, url), (tx) =>
        tx.query<{ id: string; name: string }>(`DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[]) RETURNING id, name`, [bucket, names])
      );
      for (const row of deleted.rows) this.state.objects.delete(`${bucket}/${row.name}`);
      return send(req, res, 200, deleted.rows.map((row) => ({ bucket_id: bucket, name: row.name, id: row.id })));
    }

    const uploadMatch = /^object\/(.+)$/.exec(subpath);
    if (uploadMatch && (method === 'POST' || method === 'PUT')) {
      const { bucket, name } = splitBucketPath(uploadMatch[1]);
      if (!name) throw storageError(400, 'InvalidKey', 'Invalid key');
      const upsert = method === 'PUT' || header(req, 'x-upsert') === 'true';
      const bucketRow = await this.bucket(bucket);
      const upload = await parseUpload(req, body);
      const limit = bucketRow.file_size_limit === null ? null : Number(bucketRow.file_size_limit);
      if (limit !== null && upload.bytes.length > limit) {
        throw storageError(413, 'Payload too large', 'The object exceeded the maximum allowed size');
      }
      if (!mimeAllowed(bucketRow.allowed_mime_types, upload.contentType)) {
        throw storageError(415, 'invalid_mime_type', `mime type ${upload.contentType} is not supported`);
      }
      const id = randomUUID();
      const metadata = JSON.stringify({
        eTag: `"${upload.bytes.length}"`,
        size: upload.bytes.length,
        mimetype: upload.contentType,
        cacheControl: upload.cacheControl ? `max-age=${upload.cacheControl}` : 'no-cache',
        lastModified: new Date().toISOString(),
        contentLength: upload.bytes.length,
        httpStatusCode: 200
      });
      const ownerSql = caller.role === 'authenticated' ? 'auth.uid()' : 'NULL';
      try {
        await this.state.runAs(caller, this.request(req, url), async (tx) => {
          if (method === 'PUT') {
            const updated = await tx.query(
              `UPDATE storage.objects SET metadata = $3::jsonb, updated_at = now() WHERE bucket_id = $1 AND name = $2`,
              [bucket, name, metadata]
            );
            if ((updated.affectedRows ?? 0) === 0) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
            return;
          }
          // upsert:true on an existing object is an UPDATE (needs SELECT + UPDATE policies, as on Supabase).
          const exists = upsert ? await tx.query(`SELECT 1 FROM storage.objects WHERE bucket_id = $1 AND name = $2`, [bucket, name]) : null;
          if (exists && exists.rows.length > 0) {
            const updated = await tx.query(
              `UPDATE storage.objects SET metadata = $3::jsonb, updated_at = now() WHERE bucket_id = $1 AND name = $2`,
              [bucket, name, metadata]
            );
            if ((updated.affectedRows ?? 0) === 0) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
            return;
          }
          await tx.query(
            `INSERT INTO storage.objects (id, bucket_id, name, owner, owner_id, metadata)
             VALUES ($1, $2, $3, ${ownerSql}, ${ownerSql}::text, $4::jsonb)`,
            [id, bucket, name, metadata]
          );
        });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === '23505') throw storageError(409, 'Duplicate', 'The resource already exists');
        if (code === '42501') throw storageError(403, 'Unauthorized', 'new row violates row-level security policy');
        const message = error instanceof Error ? error.message : String(error);
        throw storageError(400, typeof code === 'string' ? code : 'InvalidRequest', message);
      }
      this.state.objects.set(`${bucket}/${name}`, {
        bucket,
        name,
        bytes: upload.bytes,
        contentType: upload.contentType,
        createdAt: new Date().toISOString()
      });
      return send(req, res, 200, { Key: `${bucket}/${name}`, Id: id });
    }

    if (subpath === 'bucket' && method === 'GET') {
      const rows = await this.state.runAs(caller, this.request(req, url), (tx) =>
        tx.query(`SELECT id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at FROM storage.buckets ORDER BY id`)
      );
      return send(req, res, 200, rows.rows);
    }

    throw storageError(404, 'not_found', `No Storage route for ${method} /storage/v1/${subpath}`);
  }
}
