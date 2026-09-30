/**
 * Last "vehicles on site" list read from the server, kept on this phone so the OUT list still
 * works without signal. Display convenience only: it is labelled with its age on screen, never
 * sent anywhere, and only holds what the OUT list needs (no driver phone numbers).
 */
import type { GateRecord } from './gateLogic';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface OnSiteCache {
  siteId: string;
  /** When the server list was read (ISO). */
  savedAt: string;
  vehicles: GateRecord[];
}

const KEY_PREFIX = 'ee.gate.onsite.v1.';

export function onSiteCacheKey(siteId: string): string {
  return `${KEY_PREFIX}${siteId}`;
}

/** localStorage when usable (private mode and some WebViews throw). */
export function browserKeyValueStore(): KeyValueStore | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function reduced(vehicle: GateRecord): GateRecord {
  return {
    id: vehicle.id,
    direction: 'in',
    plate: vehicle.plate,
    displayPlate: vehicle.displayPlate,
    entryTime: vehicle.entryTime,
    exitTime: null,
    linkedEntryId: null,
    makeModel: textOrNull(vehicle.makeModel),
    vehicleColour: textOrNull(vehicle.vehicleColour),
    driverName: textOrNull(vehicle.driverName),
    driverPhone: null,
    company: textOrNull(vehicle.company),
    visitReason: textOrNull(vehicle.visitReason),
    personVisited: null,
    discExpiryDate: textOrNull(vehicle.discExpiryDate),
    isDiscScanned: vehicle.isDiscScanned === true,
    source: 'cache',
    syncState: null
  };
}

/** Stores the open IN records computed from a fresh server list. Never throws. */
export function writeOnSiteCache(
  store: KeyValueStore | null,
  siteId: string,
  vehicles: readonly GateRecord[],
  savedAt: string
): void {
  if (!store || !siteId) return;
  try {
    const value: OnSiteCache = {
      siteId,
      savedAt,
      vehicles: vehicles.filter((vehicle) => vehicle.direction === 'in').map(reduced)
    };
    store.setItem(onSiteCacheKey(siteId), JSON.stringify(value));
  } catch {
    // Storage full or blocked: the list simply is not available offline.
  }
}

function isCachedVehicle(value: unknown): value is GateRecord {
  const v = value as Partial<GateRecord> | null;
  return (
    !!v &&
    typeof v.id === 'string' &&
    v.direction === 'in' &&
    typeof v.plate === 'string' &&
    v.plate !== '' &&
    typeof v.displayPlate === 'string' &&
    typeof v.entryTime === 'string' &&
    Number.isFinite(Date.parse(v.entryTime))
  );
}

/** The cached list for a site, or null. Malformed data is ignored. Never throws. */
export function readOnSiteCache(store: KeyValueStore | null, siteId: string): OnSiteCache | null {
  if (!store || !siteId) return null;
  try {
    const raw = store.getItem(onSiteCacheKey(siteId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnSiteCache> | null;
    if (!parsed || parsed.siteId !== siteId || typeof parsed.savedAt !== 'string' || !Array.isArray(parsed.vehicles)) {
      return null;
    }
    const vehicles = parsed.vehicles.filter(isCachedVehicle).map((vehicle) => reduced(vehicle));
    return { siteId, savedAt: parsed.savedAt, vehicles };
  } catch {
    return null;
  }
}
