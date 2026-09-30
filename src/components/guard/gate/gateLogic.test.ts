import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSouthAfricanLicenseDisc } from '@/lib/license-disc/parser';
import { translations, type TranslationKey } from '@/lib/i18n/translations';
import type { GateEntryPayload } from '@/types/offline';
import {
  EMPTY_GATE_FORM,
  ON_SITE_WINDOW_MS,
  buildGateEntryPayload,
  checkPlate,
  computeVehiclesOnSite,
  discMatchesPlate,
  findOnSiteByPlate,
  formFromDisc,
  formFromOnSiteVehicle,
  formatGateWhatsAppText,
  formatSastStamp,
  gateRecordFromPayload,
  gateRecordFromServerRow,
  mergeGateRecords,
  type GateRecord,
  type GateServerRow
} from './gateLogic';
import { onSiteCacheKey, readOnSiteCache, writeOnSiteCache, type KeyValueStore } from './onSiteCache';

const NOW = Date.parse('2026-09-30T10:00:00.000Z'); // 12:00 SAST
const SHIFT_ID = '7d3c9a6e-0f55-4b83-9a3e-1f4d8c2b6a10';
const NO_LOCATION = { latitude: null, longitude: null, accuracyMeters: null, locationTimestamp: null, gpsError: 'timeout' as const };
const DISC_TEXT =
  '%MVL1CC61%0164%4025T0HR%1%4025001C2GTP%CJZ297GP%JYJ128C%Sedan (closed top)%TOYOTA%COROLLA%White%AHTBB3QE300012345%2ZR1234567%2019-11-30%';

let idCounter = 0;
function uuid(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

function record(partial: Partial<GateRecord> & Pick<GateRecord, 'direction' | 'displayPlate' | 'entryTime'>): GateRecord {
  const plate = partial.displayPlate.replace(/\s+/g, '').toUpperCase();
  return {
    id: uuid(),
    plate,
    exitTime: null,
    linkedEntryId: null,
    makeModel: null,
    vehicleColour: null,
    driverName: null,
    driverPhone: null,
    company: null,
    visitReason: null,
    personVisited: null,
    discExpiryDate: null,
    isDiscScanned: false,
    source: 'server',
    syncState: null,
    ...partial
  };
}

const iso = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();
const HOUR = 3_600_000;

const en = translations.en as Record<string, string>;
const t = (key: TranslationKey, ...args: (string | number)[]) =>
  args.reduce<string>((text, arg, index) => text.replace(new RegExp(`\\{${index}\\}`, 'g'), String(arg)), en[key] ?? key);

describe('computeVehiclesOnSite', () => {
  it('lists open IN records newest first and ignores the empty case honestly', () => {
    assert.deepEqual(computeVehiclesOnSite([], { now: NOW }), []);
    const a = record({ direction: 'in', displayPlate: 'ABC 123 GP', entryTime: iso(3 * HOUR) });
    const b = record({ direction: 'in', displayPlate: 'XYZ 999 MP', entryTime: iso(1 * HOUR) });
    const list = computeVehiclesOnSite([a, b], { now: NOW });
    assert.deepEqual(
      list.map((v) => v.id),
      [b.id, a.id]
    );
  });

  it('an OUT linked to an IN closes it, even when the OUT clock is earlier (another phone)', () => {
    const inRow = record({ direction: 'in', displayPlate: 'ABC123GP', entryTime: iso(2 * HOUR) });
    const outRow = record({
      direction: 'out',
      displayPlate: 'ABC123GP',
      entryTime: iso(3 * HOUR),
      exitTime: iso(3 * HOUR),
      linkedEntryId: inRow.id
    });
    assert.deepEqual(computeVehiclesOnSite([inRow, outRow], { now: NOW }), []);
  });

  it('an unlinked OUT closes earlier INs of the same plate but not a later IN', () => {
    const early = record({ direction: 'in', displayPlate: 'ABC123GP', entryTime: iso(5 * HOUR) });
    const out = record({ direction: 'out', displayPlate: 'abc 123 gp', entryTime: iso(4 * HOUR), exitTime: iso(4 * HOUR) });
    assert.deepEqual(computeVehiclesOnSite([early, out], { now: NOW }), []);
    const later = record({ direction: 'in', displayPlate: 'ABC123GP', entryTime: iso(1 * HOUR) });
    assert.deepEqual(
      computeVehiclesOnSite([early, out, later], { now: NOW }).map((v) => v.id),
      [later.id]
    );
  });

  it('shows one row per plate when a new IN was confirmed on purpose', () => {
    const first = record({ direction: 'in', displayPlate: 'ABC123GP', entryTime: iso(5 * HOUR) });
    const second = record({ direction: 'in', displayPlate: 'ABC 123 GP', entryTime: iso(1 * HOUR) });
    const list = computeVehiclesOnSite([first, second], { now: NOW });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, second.id);
  });

  it('drops INs older than the 30-day window (reference app)', () => {
    const old = record({ direction: 'in', displayPlate: 'OLD1GP', entryTime: iso(ON_SITE_WINDOW_MS + HOUR) });
    assert.deepEqual(computeVehiclesOnSite([old], { now: NOW }), []);
  });

  it('two INs with the same timestamp and a Record-exit OUT (old bug) leave nothing on site', () => {
    // Old implementation: the OUT reused the IN time and the vehicle stayed listed ~50% of the time.
    const inRow = record({ direction: 'in', displayPlate: 'CA552194', entryTime: iso(HOUR) });
    const outRow = record({ direction: 'out', displayPlate: 'CA552194', entryTime: inRow.entryTime, exitTime: iso(0) });
    for (let i = 0; i < 20; i++) {
      const shuffled = i % 2 === 0 ? [inRow, outRow] : [outRow, inRow];
      assert.deepEqual(computeVehiclesOnSite(shuffled, { now: NOW }), []);
    }
  });
});

describe('mergeGateRecords / converters', () => {
  it('server rows win, phone records keep their upload state, cache fills gaps', () => {
    const id = uuid();
    const serverRow: GateServerRow = {
      id,
      direction: 'in',
      license_plate: 'ABC 123 GP',
      make_model: 'Toyota Hilux',
      vehicle_colour: 'White',
      driver_name: null,
      driver_phone: null,
      company: null,
      visit_reason: '',
      person_visited: null,
      entry_time: iso(HOUR),
      exit_time: null,
      linked_entry_id: null,
      disc_expiry_date: null,
      is_disc_scanned: false
    };
    const server = gateRecordFromServerRow(serverRow);
    assert.ok(server);
    assert.equal(server.plate, 'ABC123GP');
    assert.equal(server.visitReason, null);
    const device = gateRecordFromPayload(
      id,
      { direction: 'in', licensePlate: 'ABC123GP', entryTime: iso(HOUR), isDiscScanned: false, shiftId: SHIFT_ID },
      'synced'
    );
    assert.ok(device);
    const cached = record({ direction: 'in', displayPlate: 'CACHED1', entryTime: iso(HOUR), source: 'cache' });
    const merged = mergeGateRecords({ server: [server], device: [device], cached: [cached] });
    assert.equal(merged.length, 2);
    const mergedServer = merged.find((r) => r.id === id);
    assert.equal(mergedServer?.source, 'server');
    assert.equal(mergedServer?.syncState, 'synced');
    assert.equal(mergedServer?.makeModel, 'Toyota Hilux');
  });

  it('rejects malformed rows instead of inventing values', () => {
    assert.equal(
      gateRecordFromServerRow({ id: 'x', direction: 'sideways', license_plate: 'A', entry_time: iso(0) } as unknown as GateServerRow),
      null
    );
    assert.equal(gateRecordFromPayload('x', { direction: 'in', licensePlate: '  ', entryTime: iso(0) }, null), null);
    assert.equal(gateRecordFromPayload('x', { direction: 'in', licensePlate: 'A1', entryTime: 'not a date' }, null), null);
  });
});

describe('plate checks', () => {
  it('blocks only empty and over-long numbers; warns on unusual ones', () => {
    assert.deepEqual(checkPlate('   '), { level: 'error', code: 'empty' });
    assert.deepEqual(checkPlate('A'.repeat(51)), { level: 'error', code: 'too_long' });
    assert.deepEqual(checkPlate('PLAAS-CP:CP1'), { level: 'warning', code: 'unusual_chars' });
    assert.deepEqual(checkPlate('A'), { level: 'warning', code: 'unusual_length' });
    assert.equal(checkPlate('cjz 297 gp'), null);
    assert.equal(checkPlate('ND-123-456'), null);
  });

  it('finds an on-site vehicle by plate regardless of spaces/case', () => {
    const v = record({ direction: 'in', displayPlate: 'CJZ 297 GP', entryTime: iso(HOUR) });
    assert.equal(findOnSiteByPlate([v], 'cjz297gp')?.id, v.id);
    assert.equal(findOnSiteByPlate([v], ''), null);
  });
});

describe('buildGateEntryPayload', () => {
  const disc = parseSouthAfricanLicenseDisc(DISC_TEXT, { now: NOW });

  it('attaches the disc fields only when the disc plate is the saved plate', () => {
    assert.ok(disc);
    assert.equal(discMatchesPlate(disc, 'cjz 297 gp'), true);
    const form = formFromDisc(EMPTY_GATE_FORM, disc);
    assert.equal(form.plate, 'CJZ297GP');
    assert.equal(form.makeModel, 'TOYOTA COROLLA');
    assert.equal(form.colour, 'White');

    const scanned = buildGateEntryPayload({
      direction: 'in',
      form,
      disc,
      shiftId: SHIFT_ID,
      location: NO_LOCATION,
      now: NOW,
      linkedIn: null
    });
    assert.equal(scanned.isDiscScanned, true);
    assert.equal(scanned.discExpiryDate, '2019-11-30');
    assert.equal(scanned.vinNumber, 'AHTBB3QE300012345');
    assert.equal(scanned.engineNumber, '2ZR1234567');
    assert.equal(scanned.registerNumber, 'JYJ128C');
    assert.equal(scanned.vehicleDescription, 'Sedan (closed top)');
    assert.equal(scanned.entryTime, new Date(NOW).toISOString());
    assert.equal(scanned.exitTime, null);
    assert.equal(scanned.linkedEntryId, null);
    assert.equal(scanned.gpsError, 'timeout');

    const corrected = buildGateEntryPayload({
      direction: 'in',
      form: { ...form, plate: 'DEF 456 GP' },
      disc,
      shiftId: SHIFT_ID,
      location: NO_LOCATION,
      now: NOW,
      linkedIn: null
    });
    assert.equal(corrected.licensePlate, 'DEF456GP');
    assert.equal(corrected.isDiscScanned, false);
    assert.equal(corrected.discExpiryDate, null);
    assert.equal(corrected.vinNumber, null);
    assert.equal(corrected.registerNumber, null);
  });

  it('keeps empty optional fields null and trims text', () => {
    const payload = buildGateEntryPayload({
      direction: 'in',
      form: { ...EMPTY_GATE_FORM, plate: ' abc 123 gp ', driverName: '  Sipho ', company: '   ' },
      disc: null,
      shiftId: SHIFT_ID,
      location: NO_LOCATION,
      now: NOW,
      linkedIn: null
    });
    assert.equal(payload.licensePlate, 'ABC123GP');
    assert.equal(payload.driverName, 'Sipho');
    assert.equal(payload.company, null);
    assert.equal(payload.makeModel, null);
    assert.equal(payload.isDiscScanned, false);
    assert.equal(payload.shiftId, SHIFT_ID);
  });

  it('OUT links to its IN, keeps the IN time and computes the time on site', () => {
    const inRow = record({ direction: 'in', displayPlate: 'ABC123GP', entryTime: iso(2 * HOUR), driverName: 'Thabo' });
    const form = formFromOnSiteVehicle(EMPTY_GATE_FORM, inRow);
    assert.equal(form.plate, 'ABC123GP');
    assert.equal(form.driverName, 'Thabo');
    const payload = buildGateEntryPayload({
      direction: 'out',
      form: { ...form, driverPhone: '0821234567', company: 'X' },
      disc: null,
      shiftId: SHIFT_ID,
      location: NO_LOCATION,
      now: NOW,
      linkedIn: inRow
    });
    assert.equal(payload.linkedEntryId, inRow.id);
    assert.equal(payload.entryTime, inRow.entryTime);
    assert.equal(payload.exitTime, new Date(NOW).toISOString());
    assert.equal(payload.dwellDurationSeconds, 7200);
    // OUT rows only carry the fields the OUT form shows.
    assert.equal(payload.driverPhone, null);
    assert.equal(payload.company, null);
  });

  it('OUT never has an entry time after its exit (IN recorded by a phone with a fast clock)', () => {
    const future = record({ direction: 'in', displayPlate: 'ABC123GP', entryTime: new Date(NOW + 5 * 60_000).toISOString() });
    const payload = buildGateEntryPayload({
      direction: 'out',
      form: { ...EMPTY_GATE_FORM, plate: 'ABC123GP' },
      disc: null,
      shiftId: SHIFT_ID,
      location: NO_LOCATION,
      now: NOW,
      linkedIn: future
    });
    assert.ok(Date.parse(payload.entryTime) <= Date.parse(payload.exitTime ?? ''));
    assert.equal(payload.dwellDurationSeconds, 0);
    assert.equal(payload.linkedEntryId, future.id);
  });

  it('OUT without an IN record is saved unlinked with time on site 0', () => {
    const payload = buildGateEntryPayload({
      direction: 'out',
      form: { ...EMPTY_GATE_FORM, plate: 'NEW1GP' },
      disc: null,
      shiftId: SHIFT_ID,
      location: NO_LOCATION,
      now: NOW,
      linkedIn: null
    });
    assert.equal(payload.linkedEntryId, null);
    assert.equal(payload.entryTime, payload.exitTime);
    assert.equal(payload.dwellDurationSeconds, 0);
  });
});

describe('formatGateWhatsAppText', () => {
  it('prepares the reference-style notice without claiming delivery', () => {
    const disc = parseSouthAfricanLicenseDisc(DISC_TEXT, { now: NOW });
    assert.ok(disc);
    const payload: GateEntryPayload = {
      ...buildGateEntryPayload({
        direction: 'in',
        form: { ...formFromDisc(EMPTY_GATE_FORM, disc), driverName: 'Sipho' },
        disc,
        shiftId: SHIFT_ID,
        location: { latitude: -25.123456789, longitude: 28.5, accuracyMeters: 8, locationTimestamp: iso(0), gpsError: null },
        now: NOW,
        linkedIn: null
      })
    };
    const message = formatGateWhatsAppText(
      { payload, method: 'disc', guardName: 'Guard One', siteName: 'Test Farm', recordedAt: NOW },
      t
    );
    const lines = message.split('\n');
    assert.equal(lines[0], 'VEHICLE IN: CJZ297GP');
    assert.ok(message.includes('Disc expires: 2019-11-30 – EXPIRED'));
    assert.ok(message.includes('Driver: Sipho'));
    assert.ok(message.includes('Guard: Guard One – 2026-09-30 12:00'));
    assert.ok(message.includes('https://maps.google.com/?q=-25.123457,28.500000'));
    assert.ok(message.includes('Scanned from licence disc'));
    assert.ok(!/\b(sent|delivered)\b/i.test(message));
  });

  it('OUT notice shows the time on site; no GPS is stated plainly', () => {
    const inRow = record({ direction: 'in', displayPlate: 'ABC123GP', entryTime: iso(2 * HOUR + 5 * 60_000) });
    const payload = buildGateEntryPayload({
      direction: 'out',
      form: formFromOnSiteVehicle(EMPTY_GATE_FORM, inRow),
      disc: null,
      shiftId: SHIFT_ID,
      location: NO_LOCATION,
      now: NOW,
      linkedIn: inRow
    });
    const message = formatGateWhatsAppText({ payload, method: 'list', guardName: 'G', siteName: null, recordedAt: NOW }, t);
    assert.ok(message.startsWith('VEHICLE OUT: ABC123GP'));
    assert.ok(message.includes('Time on site: 2h 05m (in 09:55)'));
    assert.ok(message.includes('No GPS location'));
    assert.ok(message.includes('Chosen from booked-in vehicles'));
  });

  it('formats SAST stamps with the date only when it is not today', () => {
    assert.equal(formatSastStamp(NOW, NOW), '12:00');
    assert.equal(formatSastStamp(NOW - 24 * HOUR, NOW), '2026-09-29 12:00');
    // 23:30 UTC is already the next calendar day in SAST.
    assert.equal(formatSastStamp('2026-09-29T23:30:00.000Z', Date.parse('2026-09-30T05:00:00.000Z')), '01:30');
  });
});

describe('onSiteCache', () => {
  function memoryStore(): KeyValueStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  }

  it('round-trips open vehicles without phone numbers and ignores other sites and junk', () => {
    const store = memoryStore();
    const v = record({ direction: 'in', displayPlate: 'ABC123GP', entryTime: iso(HOUR), driverPhone: '0821234567', driverName: 'Sipho' });
    writeOnSiteCache(store, 'site-a', [v], iso(0));
    const cached = readOnSiteCache(store, 'site-a');
    assert.ok(cached);
    assert.equal(cached.vehicles.length, 1);
    assert.equal(cached.vehicles[0].source, 'cache');
    assert.equal(cached.vehicles[0].driverPhone, null);
    assert.equal(cached.vehicles[0].driverName, 'Sipho');
    assert.ok(!(store.data.get(onSiteCacheKey('site-a')) ?? '').includes('0821234567'));
    assert.equal(readOnSiteCache(store, 'site-b'), null);
    store.setItem(onSiteCacheKey('site-c'), '{not json');
    assert.equal(readOnSiteCache(store, 'site-c'), null);
    assert.equal(readOnSiteCache(null, 'site-a'), null);
  });

  it('never throws when storage fails', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      }
    };
    writeOnSiteCache(broken, 'site-a', [], iso(0));
    assert.equal(readOnSiteCache(broken, 'site-a'), null);
  });
});
