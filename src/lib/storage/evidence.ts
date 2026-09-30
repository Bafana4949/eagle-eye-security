/**
 * Private evidence storage (Supabase Storage bucket `evidence-media`).
 *
 * Object path layout (enforced by the storage.objects RLS policies):
 *   {organisation_id}/{site_id}/{category}/{user_id}/{event_uuid}-{field}.{ext}
 * - [1] must be the caller's organisation, [4] the caller's user id (INSERT).
 * - category ∈ selfie | incident | vehicle | patrol.
 * Database *_url columns store this PATH, never a URL. Viewing goes through a short-lived
 * signed URL created for the viewer's own session (RLS decides who may read which object).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EvidenceCategory } from '@/types/models';
import type { OfflineEventType } from '@/types/offline';

export const EVIDENCE_BUCKET = 'evidence-media';
export const EVIDENCE_CATEGORIES: readonly EvidenceCategory[] = ['selfie', 'incident', 'vehicle', 'patrol'];
/** Mirrors the bucket configuration (10 MB, jpeg/png/webp). */
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELD_PATTERN = /^[a-z0-9_]{1,32}$/;
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

export interface EvidencePathParts {
  organisationId: string;
  siteId: string;
  category: EvidenceCategory;
  userId: string;
  eventId: string;
  field: string;
  /** Content type of the file; selects the extension (default image/jpeg → .jpg). */
  mimeType?: string;
}

function uuidSegment(label: string, value: string): string {
  const normalised = typeof value === 'string' ? value.trim().toLowerCase() : '';
  // Policies compare against uuid::text, which is always lower-case canonical form.
  if (!UUID_PATTERN.test(normalised)) {
    throw new Error(`buildEvidencePath: ${label} must be a UUID`);
  }
  return normalised;
}

/** Builds the deterministic object path for one media field of one event. */
export function buildEvidencePath(parts: EvidencePathParts): string {
  const organisationId = uuidSegment('organisationId', parts.organisationId);
  const siteId = uuidSegment('siteId', parts.siteId);
  const userId = uuidSegment('userId', parts.userId);
  const eventId = uuidSegment('eventId', parts.eventId);
  if (!EVIDENCE_CATEGORIES.includes(parts.category)) {
    throw new Error(`buildEvidencePath: unknown category "${String(parts.category)}"`);
  }
  if (!FIELD_PATTERN.test(parts.field)) {
    throw new Error('buildEvidencePath: field must be 1-32 characters of [a-z0-9_]');
  }
  const extension = EXTENSIONS[parts.mimeType ?? 'image/jpeg'];
  if (!extension) {
    throw new Error(`buildEvidencePath: unsupported content type "${String(parts.mimeType)}"`);
  }
  return `${organisationId}/${siteId}/${parts.category}/${userId}/${eventId}-${parts.field}.${extension}`;
}

/** Parses a path produced by buildEvidencePath (null for anything else, e.g. a legacy public URL). */
export function parseEvidencePath(path: string): Omit<EvidencePathParts, 'mimeType'> | null {
  if (typeof path !== 'string') return null;
  const match = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/(selfie|incident|vehicle|patrol)\/([0-9a-f-]{36})\/([0-9a-f-]{36})-([a-z0-9_]{1,32})\.(jpg|png|webp)$/.exec(
    path
  );
  if (!match) return null;
  const [, organisationId, siteId, category, userId, eventId, field] = match;
  if (![organisationId, siteId, userId, eventId].every((id) => UUID_PATTERN.test(id))) return null;
  return { organisationId, siteId, category: category as EvidenceCategory, userId, eventId, field };
}

/** Evidence category for an event's media (panic alerts carry no media). */
export function evidenceCategoryForEvent(eventType: OfflineEventType): EvidenceCategory | null {
  switch (eventType) {
    case 'shift_start':
    case 'shift_end':
      return 'selfie';
    case 'incident':
      return 'incident';
    case 'gate_entry':
      return 'vehicle';
    case 'checkpoint_scan':
      return 'patrol';
    case 'panic':
      return null;
  }
}

async function defaultClient(): Promise<Pick<SupabaseClient, 'storage'>> {
  const mod = await import('@/lib/supabase/client');
  return mod.createClient();
}

/**
 * Short-lived signed URL for viewing one evidence object with the caller's own session.
 * Throws when the path is not an evidence path or the caller may not read it (RLS).
 */
export async function getEvidenceSignedUrl(
  path: string,
  expiresInSeconds = 300,
  client?: Pick<SupabaseClient, 'storage'>
): Promise<string> {
  if (!parseEvidencePath(path)) {
    throw new Error('Not an evidence storage path (older records may hold an unusable public URL).');
  }
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 3600) {
    throw new Error('getEvidenceSignedUrl: expiresInSeconds must be an integer between 1 and 3600');
  }
  const supabase = client ?? (await defaultClient());
  const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) {
    throw new Error(`Could not open evidence: ${error?.message ?? 'no signed URL returned'}`);
  }
  return data.signedUrl;
}
