/**
 * Tamper-evident chain over a guard's checkpoint scans on one device:
 *   hash = sha256((prevHash ?? '') + canonicalJson(core))
 * where prevHash is the hash of the same user's previous scan (null for the first).
 * The chain is sent as patrol_scans.hash_chain / prev_hash_chain. It proves the order and
 * content of scans as recorded on the device; it does not make the device clock trustworthy.
 *
 * Canonical form: keys sorted, no whitespace, timestamps as ISO-8601 UTC with milliseconds
 * (Date#toISOString), absent location values as null.
 */
import type { CheckpointPayloadType, ScanMethod } from '@/types/models';
import type { CheckpointScanPayload } from '@/types/offline';
import { canonicalJson, sha256 } from '@/lib/utils/hash';

export interface ScanChainCore {
  eventId: string;
  guardId: string;
  shiftId: string;
  checkpointId: string;
  method: ScanMethod;
  payloadType: CheckpointPayloadType;
  scannedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  locationTimestamp: string | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function scanChainCore(input: {
  eventId: string;
  guardId: string;
  scannedAt: string;
  payload: CheckpointScanPayload;
}): ScanChainCore {
  const { payload } = input;
  return {
    eventId: input.eventId,
    guardId: input.guardId,
    shiftId: payload.shiftId,
    checkpointId: payload.checkpointId,
    method: payload.method,
    payloadType: payload.payloadType,
    scannedAt: new Date(input.scannedAt).toISOString(),
    latitude: finiteOrNull(payload.latitude),
    longitude: finiteOrNull(payload.longitude),
    accuracyMeters: finiteOrNull(payload.accuracyMeters),
    locationTimestamp: payload.locationTimestamp ? new Date(payload.locationTimestamp).toISOString() : null
  };
}

export async function computeScanHash(prevHash: string | null, core: ScanChainCore): Promise<string> {
  return sha256((prevHash ?? '') + canonicalJson(core));
}

export interface ChainLink {
  prevHash: string | null;
  hash: string;
  core: ScanChainCore;
}

export type ChainVerification = { ok: true } | { ok: false; index: number; reason: 'broken_link' | 'hash_mismatch' };

/** Verifies links in chain order (oldest first): every prevHash matches and every hash recomputes. */
export async function verifyScanChain(links: readonly ChainLink[]): Promise<ChainVerification> {
  let expectedPrev: string | null = links.length > 0 ? links[0].prevHash : null;
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (link.prevHash !== expectedPrev) return { ok: false, index, reason: 'broken_link' };
    if ((await computeScanHash(link.prevHash, link.core)) !== link.hash) {
      return { ok: false, index, reason: 'hash_mismatch' };
    }
    expectedPrev = link.hash;
  }
  return { ok: true };
}
