import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from '@/types/models';
import {
  cardReference,
  newCheckpointFormValues,
  parseCoordinates,
  siteToFormValues,
  validateCheckpointForm,
  validateLegacyCode,
  validateOptionalPhone,
  validateSiteForm,
  validateWhatsAppNumber
} from './validation';
import { createStaffSchema, generateStaffPassword, MIN_PASSWORD_LENGTH } from './staffSchema';
import { redactAuditDetails, toAdminError } from './adminData';
import { adminErrorKey } from './format';
import { isCrossOriginRequest } from '@/app/api/admin/users/provision';

const SITE: Site = {
  id: 'site-1',
  organisationId: 'org-1',
  name: 'Hoofplaas',
  code: 'DW-01',
  defaultRadiusMeters: 50,
  dayShiftStart: '06:00',
  dayShiftEnd: '18:00',
  nightShiftStart: '18:00',
  nightShiftEnd: '06:00',
  roundIntervalMinutes: 60,
  policePhone: '',
  isActive: true,
  allowLegacyQr: false
};

describe('coordinates', () => {
  test('both empty means "no location"; one empty is an error', () => {
    assert.deepEqual(parseCoordinates('', ' '), { ok: true, latitude: null, longitude: null });
    assert.deepEqual(parseCoordinates('-25.6', ''), { ok: false, field: 'longitude', key: 'admErrCoordsBoth' });
    assert.deepEqual(parseCoordinates('', '27.8'), { ok: false, field: 'latitude', key: 'admErrCoordsBoth' });
  });

  test('accepts a decimal comma and rejects out-of-range or non-numeric values', () => {
    assert.deepEqual(parseCoordinates('-25,684120', '27.81452'), { ok: true, latitude: -25.68412, longitude: 27.81452 });
    assert.equal(parseCoordinates('-91', '27').ok, false);
    assert.equal(parseCoordinates('-25', '181').ok, false);
    assert.equal(parseCoordinates('abc', '27').ok, false);
    assert.equal(parseCoordinates('1e3', '27').ok, false);
  });
});

describe('phone numbers', () => {
  test('WhatsApp dispatch numbers are stored as E.164 SA mobiles; empty means not configured', () => {
    assert.deepEqual(validateWhatsAppNumber('082 123 4567'), { ok: true, value: '+27821234567' });
    assert.deepEqual(validateWhatsAppNumber('+27 (0)82-123-4567'), { ok: true, value: '+27821234567' });
    assert.deepEqual(validateWhatsAppNumber('  '), { ok: true, value: null });
    assert.deepEqual(validateWhatsAppNumber('011 123 4567'), { ok: false, key: 'admErrWaNotMobile' });
    assert.deepEqual(validateWhatsAppNumber('+44 7700 900123'), { ok: false, key: 'admErrWaNotSa' });
    assert.deepEqual(validateWhatsAppNumber('082 123'), { ok: false, key: 'admErrWaLength' });
    assert.deepEqual(validateWhatsAppNumber('082-CALL-ME'), { ok: false, key: 'admErrWaChars' });
  });

  test('emergency / police numbers: optional, digits only (10111 is valid)', () => {
    assert.deepEqual(validateOptionalPhone('10111'), { ok: true, value: '10111' });
    assert.deepEqual(validateOptionalPhone('  +27  82 999 0000 '), { ok: true, value: '+27 82 999 0000' });
    assert.deepEqual(validateOptionalPhone(''), { ok: true, value: null });
    assert.equal(validateOptionalPhone('12').ok, false);
    assert.equal(validateOptionalPhone('call Dawie').ok, false);
  });
});

describe('legacy card codes', () => {
  test('accepts the bare code or the full printed PLAAS-CP text', () => {
    assert.deepEqual(validateLegacyCode('CP1'), { ok: true, value: 'CP1' });
    assert.deepEqual(validateLegacyCode('plaas-cp:CP6'), { ok: true, value: 'CP6' });
    assert.deepEqual(validateLegacyCode(''), { ok: true, value: null });
    assert.equal(validateLegacyCode('CP 1').ok, false);
  });
});

describe('site form', () => {
  test('form values come from the stored site without invented defaults', () => {
    const values = siteToFormValues(SITE);
    assert.equal(values.whatsapp, '');
    assert.equal(values.emergencyPhone, '');
    assert.equal(values.policePhone, '');
    assert.equal(values.latitude, '');
  });

  test('a valid form becomes the row to write (WhatsApp normalised, empty phones as null)', () => {
    const values = { ...siteToFormValues(SITE), whatsapp: '0821234567', latitude: '-25.68', longitude: '27.81', roundInterval: '30' };
    const result = validateSiteForm(values);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.whatsappDispatchNumber, '+27821234567');
    assert.equal(result.value.emergencyPhone, null);
    assert.equal(result.value.policePhone, null);
    assert.equal(result.value.roundIntervalMinutes, 30);
    assert.equal(result.value.latitude, -25.68);
  });

  test('refuses identical shift start/end, an out-of-range interval and radius, and bad times', () => {
    const result = validateSiteForm({
      ...siteToFormValues(SITE),
      dayEnd: '06:00',
      roundInterval: '5',
      defaultRadius: '2',
      nightStart: '25:00',
      code: 'DW 01'
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors.dayEnd, 'admErrShiftSameTimes');
    assert.equal(result.errors.roundInterval, 'admErrInterval');
    assert.equal(result.errors.defaultRadius, 'admErrRadius');
    assert.equal(result.errors.nightStart, 'admErrTime');
    assert.equal(result.errors.code, 'admErrSiteCode');
  });
});

describe('checkpoint form', () => {
  test('a new form uses the site radius and the next order number', () => {
    const values = newCheckpointFormValues(60, [
      { id: 'a', siteId: 's', name: 'A', permittedRadiusMeters: 50, orderIndex: 3, isActive: true },
      { id: 'b', siteId: 's', name: 'B', permittedRadiusMeters: 50, orderIndex: 7, isActive: false }
    ]);
    assert.equal(values.radius, '60');
    assert.equal(values.order, '8');
  });

  test('validates and converts values', () => {
    const ok = validateCheckpointForm({ name: ' Pump ', description: '', radius: '40', order: '2', legacyCode: 'PLAAS-CP:CP2', latitude: '', longitude: '' });
    assert.deepEqual(ok, {
      ok: true,
      value: { name: 'Pump', description: null, permittedRadiusMeters: 40, orderIndex: 2, legacyCode: 'CP2', latitude: null, longitude: null }
    });
    const bad = validateCheckpointForm({ name: '', description: '', radius: '0', order: '-1', legacyCode: 'bad code', latitude: '1', longitude: '' });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.deepEqual(Object.keys(bad.errors).sort(), ['legacyCode', 'longitude', 'name', 'order', 'radius']);
  });

  test('card reference is the tail of the token', () => {
    assert.equal(cardReference('EE-CP-0123456789ABCDEF0123456789ABCDEF'), 'ABCDEF');
  });
});

describe('create staff request', () => {
  const base = {
    firstName: ' Sipho ',
    lastName: 'Khoza',
    role: 'guard',
    login: { kind: 'username', username: ' Wag3 ' },
    password: 'a'.repeat(MIN_PASSWORD_LENGTH),
    preferredLanguage: 'zu',
    siteIds: ['6F9619FF-8B86-D011-B42D-00C04FC964FF', '6f9619ff-8b86-d011-b42d-00c04fc964ff']
  };

  test('normalises the login and de-duplicates site ids', () => {
    const parsed = createStaffSchema.safeParse(base);
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.deepEqual(parsed.data.login, { kind: 'username', username: 'wag3' });
    assert.equal(parsed.data.firstName, 'Sipho');
    assert.deepEqual(parsed.data.siteIds, ['6f9619ff-8b86-d011-b42d-00c04fc964ff']);
    assert.equal(parsed.data.employeeNumber, null);
  });

  test('the organisation can never be supplied by the client (strict schema)', () => {
    assert.equal(createStaffSchema.safeParse({ ...base, organisationId: '11111111-1111-1111-1111-111111111111' }).success, false);
  });

  test('refuses short passwords, bad usernames, bad e-mails and unknown roles', () => {
    assert.equal(createStaffSchema.safeParse({ ...base, password: 'short' }).success, false);
    assert.equal(createStaffSchema.safeParse({ ...base, password: ` ${'a'.repeat(12)}` }).success, false);
    assert.equal(createStaffSchema.safeParse({ ...base, login: { kind: 'username', username: 'wag 3' } }).success, false);
    assert.equal(createStaffSchema.safeParse({ ...base, login: { kind: 'email', email: 'not-an-email' } }).success, false);
    assert.equal(createStaffSchema.safeParse({ ...base, role: 'owner' }).success, false);
    assert.equal(createStaffSchema.safeParse({ ...base, siteIds: ['site-1'] }).success, false);
  });

  test('generated passwords use crypto randomness and an unambiguous alphabet', () => {
    const password = generateStaffPassword();
    assert.equal(password.length, 14);
    assert.match(password, /^[A-HJ-NP-Za-km-z2-9]+$/);
    let calls = 0;
    const fixed = generateStaffPassword(4, (bytes) => {
      calls += 1;
      return bytes.fill(0);
    });
    assert.equal(fixed, 'AAAA');
    assert.ok(calls >= 1);
  });
});

describe('POST /api/admin/users cross-site check', () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  test('the admin page itself passes, even when the framework resolved the host differently', () => {
    // Browser on http://127.0.0.1:3191, framework URL normalised to localhost (seen with next dev -H).
    assert.equal(isCrossOriginRequest(headers({ origin: 'http://127.0.0.1:3191', host: '127.0.0.1:3191' }), 'localhost:3191'), false);
    assert.equal(isCrossOriginRequest(headers({ 'sec-fetch-site': 'same-origin', origin: 'https://ee.example.co.za' }), 'internal:3000'), false);
    // Behind a hosting proxy.
    assert.equal(
      isCrossOriginRequest(headers({ origin: 'https://ee.example.co.za', host: 'internal:3000', 'x-forwarded-host': 'ee.example.co.za' }), 'internal:3000'),
      false
    );
    // Non-browser client without Origin: the session check decides.
    assert.equal(isCrossOriginRequest(headers({ host: 'ee.example.co.za' }), 'ee.example.co.za'), false);
  });

  test('another site is refused', () => {
    assert.equal(isCrossOriginRequest(headers({ 'sec-fetch-site': 'cross-site', origin: 'https://ee.example.co.za' }), 'ee.example.co.za'), true);
    assert.equal(isCrossOriginRequest(headers({ 'sec-fetch-site': 'same-site' }), 'ee.example.co.za'), true);
    assert.equal(isCrossOriginRequest(headers({ origin: 'https://evil.example', host: 'ee.example.co.za' }), 'ee.example.co.za'), true);
    assert.equal(isCrossOriginRequest(headers({ origin: 'null', host: 'ee.example.co.za' }), 'ee.example.co.za'), true);
  });
});

describe('admin errors and audit details', () => {
  test('maps server codes to what the admin is told', () => {
    assert.equal(toAdminError({ code: '42501', message: 'x' }).kind, 'not_allowed');
    assert.equal(toAdminError({ code: 'PGRST116', message: '0 rows' }).kind, 'not_found');
    assert.equal(toAdminError({ code: '23001', message: 'restrict' }).kind, 'in_use');
    assert.equal(toAdminError({ code: '23505', message: 'dup' }).kind, 'conflict');
    assert.equal(toAdminError(new TypeError('Failed to fetch')).kind, 'network');
    assert.equal(adminErrorKey({ kind: 'conflict', message: '', problem: 'duplicate_tag' }), 'admErrDuplicateTag');
    assert.equal(adminErrorKey({ kind: 'network', message: '', problem: 'error' }), 'admErrNetwork');
  });

  test('printed QR tokens and raw tag serials in audit details are hidden, fingerprints and the rest are kept', () => {
    const details = {
      name: 'Main gate',
      nfc_uid_old: null,
      nfc_uid_new: '04:a2:3b:1c:5d:80:00',
      changes: {
        qr_code_hash: { old: 'EE-CP-OLD', new: 'EE-CP-NEW' },
        nfc_uid: { old: null, new: '04:a2:3b:1c:5d:80:00' },
        nfc_uid_sha256: { old: null, new: 'ab12' },
        name: { old: 'A', new: 'B' }
      }
    };
    assert.deepEqual(redactAuditDetails(details), {
      name: 'Main gate',
      nfc_uid_old: null,
      nfc_uid_new: '[hidden]',
      changes: { qr_code_hash: '[hidden]', nfc_uid: '[hidden]', nfc_uid_sha256: { old: null, new: 'ab12' }, name: { old: 'A', new: 'B' } }
    });
    assert.deepEqual(redactAuditDetails({ changes: [{ qr_code_hash: 'EE-CP-X' }] }, 'versteek'), { changes: [{ qr_code_hash: 'versteek' }] });
  });
});
