import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { translations } from '@/lib/i18n/translations';
import type { LocationFixResult } from '@/lib/gps/location';
import {
  INCIDENT_TYPES,
  buildIncidentMessage,
  buildPanicMessage,
  deriveRecordStatus,
  deriveSosStage,
  holdProgress,
  holdSecondsLeft,
  incidentTypeLabel,
  isAcknowledged,
  locationLine,
  messageLocationFromFix,
  newestLocation,
  policeNumber,
  recordStatusTone,
  shortEventId,
  telHref,
  whatsAppRecipient,
  type MessageLocation,
  type PanicAcknowledgement,
  type Translate
} from './incidentLogic';

const t: Translate = (key, ...args) =>
  args.reduce<string>((text, arg, index) => text.split(`{${index}}`).join(String(arg)), translations.en[key]);

const EVENT_ID = '3f9a12c0-4b5d-4e6f-8a7b-9c0d1e2f3a4b';
const NOW = Date.UTC(2026, 8, 30, 20, 15, 0); // 22:15 SAST

const fresh: MessageLocation = { latitude: -25.123456, longitude: 28.654321, accuracyMeters: 12, observedAt: NOW - 20_000 };

describe('shortEventId', () => {
  it('shows the first 8 hex digits of the real event id', () => {
    assert.equal(shortEventId(EVENT_ID), '3F9A12C0');
  });
});

describe('telHref / policeNumber', () => {
  it('keeps + and digits only', () => {
    assert.equal(telHref('+27 82 123-4567'), 'tel:+27821234567');
    assert.equal(telHref('(012) 345 6789'), 'tel:0123456789');
  });
  it('returns null when nothing dialable is configured', () => {
    assert.equal(telHref(''), null);
    assert.equal(telHref(undefined), null);
    assert.equal(telHref('n/a'), null);
  });
  it('uses the site police number, and 10111 only when the site has none', () => {
    assert.deepEqual(policeNumber('012 345 6789'), { number: '012 345 6789', isNationalFallback: false });
    assert.deepEqual(policeNumber(''), { number: '10111', isNationalFallback: true });
    assert.deepEqual(policeNumber('   '), { number: '10111', isNationalFallback: true });
  });
});

describe('whatsAppRecipient', () => {
  it('reports a missing dispatch number instead of inventing one', () => {
    assert.deepEqual(whatsAppRecipient(undefined), { kind: 'missing' });
    assert.deepEqual(whatsAppRecipient('  '), { kind: 'missing' });
  });
  it('normalises a valid SA mobile number', () => {
    const r = whatsAppRecipient('082 123 4567');
    assert.equal(r.kind, 'ok');
    assert.equal(r.kind === 'ok' && r.digits, '27821234567');
  });
  it('rejects a landline with its reason', () => {
    assert.deepEqual(whatsAppRecipient('012 345 6789'), { kind: 'invalid', reason: 'not_mobile' });
  });
});

describe('record status (truthful upload wording)', () => {
  it('is only "received" when the queue item is synced', () => {
    assert.equal(deriveRecordStatus({ loaded: true, syncState: 'synced', isOnline: true }), 'received');
    assert.equal(deriveRecordStatus({ loaded: true, syncState: 'pending', isOnline: true }), 'waiting');
    assert.equal(deriveRecordStatus({ loaded: true, syncState: 'syncing', isOnline: true }), 'uploading');
  });
  it('says queued offline, retrying, failed or unknown honestly', () => {
    assert.equal(deriveRecordStatus({ loaded: true, syncState: 'pending', isOnline: false }), 'queued_offline');
    assert.equal(
      deriveRecordStatus({ loaded: true, syncState: 'pending', isOnline: true, lastError: 'timeout' }),
      'retrying'
    );
    assert.equal(deriveRecordStatus({ loaded: true, syncState: 'failed', isOnline: true }), 'failed');
    assert.equal(deriveRecordStatus({ loaded: true, syncState: undefined, isOnline: true }), 'unknown');
    assert.equal(deriveRecordStatus({ loaded: false, syncState: 'synced', isOnline: true }), 'loading');
  });
  it('maps statuses to theme tones', () => {
    assert.equal(recordStatusTone('received'), 'success');
    assert.equal(recordStatusTone('failed'), 'danger');
    assert.equal(recordStatusTone('queued_offline'), 'warning');
  });
});

describe('SOS stages', () => {
  const ack: PanicAcknowledgement = {
    status: 'acknowledged',
    acknowledgedAt: '2026-09-30T20:20:00Z',
    acknowledgedBy: 'b1',
    acknowledgedByName: 'Anna'
  };
  it('goes saving → queued → submitted → acknowledged only on real evidence', () => {
    assert.equal(deriveSosStage({ eventId: null, saveError: null, syncState: undefined, acknowledgement: null }), 'saving');
    assert.equal(deriveSosStage({ eventId: EVENT_ID, saveError: null, syncState: 'pending', acknowledgement: null }), 'queued');
    assert.equal(deriveSosStage({ eventId: EVENT_ID, saveError: null, syncState: 'syncing', acknowledgement: null }), 'queued');
    assert.equal(deriveSosStage({ eventId: EVENT_ID, saveError: null, syncState: 'synced', acknowledgement: null }), 'submitted');
    assert.equal(deriveSosStage({ eventId: EVENT_ID, saveError: null, syncState: 'synced', acknowledgement: ack }), 'acknowledged');
  });
  it('reports failures', () => {
    assert.equal(deriveSosStage({ eventId: null, saveError: 'QuotaExceededError', syncState: undefined, acknowledgement: null }), 'save_failed');
    assert.equal(deriveSosStage({ eventId: EVENT_ID, saveError: null, syncState: 'failed', acknowledgement: null }), 'failed');
  });
  it('treats an active row without acknowledged_at as not acknowledged', () => {
    assert.equal(isAcknowledged({ status: 'active', acknowledgedAt: null }), false);
    assert.equal(isAcknowledged({ status: 'resolved', acknowledgedAt: null }), true);
    assert.equal(isAcknowledged(null), false);
  });
});

describe('locations in messages', () => {
  it('converts only real fixes', () => {
    const failure: LocationFixResult = { status: 'permission_denied', message: 'denied' };
    assert.equal(messageLocationFromFix(failure, NOW), null);
    assert.equal(messageLocationFromFix(null, NOW), null);
    const ok: LocationFixResult = { status: 'ok', latitude: -25, longitude: 28, accuracy: Infinity, timestamp: NOW, ageMs: 3000 };
    assert.deepEqual(messageLocationFromFix(ok, NOW), { latitude: -25, longitude: 28, accuracyMeters: null, observedAt: NOW - 3000 });
  });
  it('prefers the newer position', () => {
    const older = { ...fresh, observedAt: NOW - 600_000 };
    assert.equal(newestLocation(older, fresh), fresh);
    assert.equal(newestLocation(fresh, null), fresh);
    assert.equal(newestLocation(null, null), null);
  });
  it('labels old positions as last known and missing GPS as such', () => {
    assert.equal(locationLine(fresh, t, NOW), 'https://maps.google.com/?q=-25.123456,28.654321 (±12 m)');
    const old = { ...fresh, observedAt: NOW - 6 * 60_000 };
    assert.equal(locationLine(old, t, NOW), 'Last known position (6 min ago): https://maps.google.com/?q=-25.123456,28.654321 (±12 m)');
    assert.equal(locationLine(null, t, NOW), 'No GPS location');
  });
});

describe('WhatsApp texts', () => {
  it('builds the SOS text from real values only', () => {
    const text = buildPanicMessage(
      { guardName: 'Sipho Khoza', siteName: 'Main farm', triggeredAt: NOW, location: fresh, alertId: EVENT_ID, nowMs: NOW },
      t
    );
    assert.equal(
      text,
      [
        'SOS! Sipho Khoza needs help',
        'Site: Main farm',
        '2026-09-30 22:15',
        'https://maps.google.com/?q=-25.123456,28.654321 (±12 m)',
        'Alert ID: 3F9A12C0'
      ].join('\n')
    );
    assert.doesNotMatch(text, /sent|delivered|notified/i);
  });
  it('states missing GPS and a missing name instead of inventing them', () => {
    const text = buildPanicMessage(
      { guardName: null, siteName: null, triggeredAt: NOW, location: null, alertId: null, nowMs: NOW },
      t
    );
    assert.equal(text, ['SOS! A guard needs help', '2026-09-30 22:15', 'No GPS location'].join('\n'));
  });
  it('builds the incident text with type, severity, description and record id', () => {
    const text = buildIncidentMessage(
      {
        incidentType: 'fence',
        severity: 'high',
        description: '  Wire cut near the river  ',
        guardName: 'Sipho Khoza',
        siteName: 'Main farm',
        reportedAt: NOW,
        location: null,
        recordId: EVENT_ID,
        nowMs: NOW
      },
      t
    );
    assert.equal(
      text,
      [
        'INCIDENT: Fence cut or damaged',
        'Severity: High',
        'Sipho Khoza – 2026-09-30 22:15',
        'Site: Main farm',
        'Wire cut near the river',
        'No GPS location',
        'Record ID: 3F9A12C0'
      ].join('\n')
    );
  });
  it('shows unknown stored types as stored and covers every reference type', () => {
    assert.equal(incidentTypeLabel('theft', t), 'theft');
    assert.deepEqual([...INCIDENT_TYPES], ['fence', 'gate', 'stock', 'person', 'fire', 'other']);
    for (const type of INCIDENT_TYPES) assert.notEqual(incidentTypeLabel(type, t), type);
  });
});

describe('press-and-hold', () => {
  it('needs the full 2 seconds', () => {
    assert.equal(holdProgress(0), 0);
    assert.equal(holdProgress(-5), 0);
    assert.equal(holdProgress(1000), 0.5);
    assert.equal(holdProgress(1999) < 1, true);
    assert.equal(holdProgress(2000), 1);
    assert.equal(holdProgress(5000), 1);
    assert.equal(holdProgress(Number.NaN), 0);
  });
  it('counts down in tenths, rounded up', () => {
    assert.equal(holdSecondsLeft(0), '2.0');
    assert.equal(holdSecondsLeft(610), '1.4');
    assert.equal(holdSecondsLeft(1999), '0.1');
    assert.equal(holdSecondsLeft(2500), '0.0');
  });
});
