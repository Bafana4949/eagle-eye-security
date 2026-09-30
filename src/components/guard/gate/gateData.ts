'use client';

/**
 * Browser data access for the gate screen: gate events recorded on this phone (Dexie), the
 * site's gate_entries rows (Supabase, RLS: site members), the offline copy of the on-site list,
 * and a bounded GPS capture for new entries. Nothing here writes to the server — new entries go
 * through syncEngine.enqueue in the page.
 */
import { offlineDB } from '@/lib/offline/db';
import { createClient } from '@/lib/supabase/client';
import { getLocationFix } from '@/lib/gps/location';
import { eventLocationFromFix } from '@/lib/offline/eventLocation';
import type { EventLocation, GateEntryPayload } from '@/types/offline';
import {
  GATE_ENTRY_COLUMNS,
  GATE_SERVER_ROW_LIMIT,
  ON_SITE_WINDOW_MS,
  computeVehiclesOnSite,
  gateRecordFromPayload,
  gateRecordFromServerRow,
  mergeGateRecords,
  type GateRecord,
  type GateServerRow
} from './gateLogic';
import { browserKeyValueStore, readOnSiteCache, writeOnSiteCache } from './onSiteCache';

/** The longest a save waits for GPS before recording the entry without a location. */
export const GATE_GPS_WAIT_MS = 5000;

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

/** Gate events of this site recorded on this phone (any account), with their upload state. */
export async function readDeviceGateRecords(siteId: string, now: number): Promise<GateRecord[]> {
  if (!offlineDB) return [];
  const windowStart = now - ON_SITE_WINDOW_MS;
  const events = await offlineDB.localEvents
    .where('type')
    .equals('gate_entry')
    .filter((event) => event.siteId === siteId && Date.parse(event.createdAt) >= windowStart)
    .toArray();
  if (events.length === 0) return [];
  const items = await offlineDB.syncQueue.bulkGet(events.map((event) => event.id));
  return events
    .map((event, index) =>
      gateRecordFromPayload(event.id, event.payload as Partial<GateEntryPayload>, items[index]?.syncState ?? null)
    )
    .filter(notNull);
}

/** The site's gate_entries rows of the last 30 days (IN rows and the OUT rows that close them). */
export async function readServerGateRecords(siteId: string, now: number): Promise<GateRecord[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('gate_entries')
    .select(GATE_ENTRY_COLUMNS)
    .eq('site_id', siteId)
    .gte('entry_time', new Date(now - ON_SITE_WINDOW_MS).toISOString())
    .order('entry_time', { ascending: false })
    .limit(GATE_SERVER_ROW_LIMIT);
  if (error) throw new Error(error.message || 'Could not read gate entries');
  return ((data ?? []) as unknown as GateServerRow[]).map(gateRecordFromServerRow).filter(notNull);
}

export type OnSiteSource = 'server' | 'cache' | 'device';

export interface OnSiteSnapshot {
  siteId: string;
  records: GateRecord[];
  /** Where the non-phone part of the list came from. */
  source: OnSiteSource;
  /** The server was asked but did not answer (offline lists come from 'cache' or 'device'). */
  serverFailed: boolean;
  /** When the server list was read (ISO), for 'server' and 'cache'. */
  serverListAt: string | null;
}

/**
 * Everything the on-site list needs: server rows when reachable (the open ones are then kept on
 * this phone for offline use), otherwise the last kept list; always merged with this phone's
 * own gate events so vehicles recorded offline show immediately.
 */
export async function loadOnSiteSnapshot(siteId: string): Promise<OnSiteSnapshot> {
  const now = Date.now();
  const device = await readDeviceGateRecords(siteId, now);
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  let server: GateRecord[] | null = null;
  let serverFailed = false;
  if (online) {
    try {
      server = await readServerGateRecords(siteId, now);
    } catch {
      serverFailed = true;
    }
  }
  const store = browserKeyValueStore();
  if (server) {
    const readAt = new Date(now).toISOString();
    writeOnSiteCache(store, siteId, computeVehiclesOnSite(server, { now }), readAt);
    return { siteId, records: mergeGateRecords({ server, device }), source: 'server', serverFailed: false, serverListAt: readAt };
  }
  const cache = readOnSiteCache(store, siteId);
  return {
    siteId,
    records: mergeGateRecords({ device, cached: cache?.vehicles ?? [] }),
    source: cache ? 'cache' : 'device',
    serverFailed,
    serverListAt: cache?.savedAt ?? null
  };
}

const NO_FIX_TIMEOUT: EventLocation = {
  latitude: null,
  longitude: null,
  accuracyMeters: null,
  locationTimestamp: null,
  gpsError: 'timeout'
};

/**
 * Location for a new gate entry. Answers at once from the warm watch during a shift; otherwise
 * waits at most GATE_GPS_WAIT_MS and records the entry without coordinates (gpsError says why).
 */
export async function captureGateLocation(): Promise<EventLocation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), GATE_GPS_WAIT_MS);
  });
  try {
    const fix = await Promise.race([
      getLocationFix({ maxAgeMs: 30000, timeoutMs: GATE_GPS_WAIT_MS - 1000, coarseRetry: false }),
      timeout
    ]);
    return fix ? eventLocationFromFix(fix) : NO_FIX_TIMEOUT;
  } catch {
    return NO_FIX_TIMEOUT;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
