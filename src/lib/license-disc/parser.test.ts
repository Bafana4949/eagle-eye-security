import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  discExpiryStatus,
  isValidIsoDate,
  isValidSouthAfricanPlate,
  parseSouthAfricanLicenseDisc,
  plateFormatWarning,
  todayInSouthAfrica
} from './parser';

// Real SA disc layout (same field order as Dawie's reference parseDisc).
const DISC =
  '%MVL1CC61%0164%4025T0HR%1%4025001C2GTP%CJZ297GP%JYJ128C%Sedan (closed top)%TOYOTA%COROLLA%White%AHTBB3QE300012345%2ZR1234567%2019-11-30%';

describe('South African licence disc parser', () => {
  it('parses a realistic MVL disc string with the reference offsets', () => {
    const r = parseSouthAfricanLicenseDisc(DISC, { today: '2019-11-01' });
    assert.deepStrictEqual(r, {
      plate: 'CJZ297GP',
      regNumber: 'JYJ128C',
      description: 'Sedan (closed top)',
      make: 'TOYOTA',
      model: 'COROLLA',
      colour: 'White',
      vin: 'AHTBB3QE300012345',
      engineNumber: '2ZR1234567',
      expiryDate: '2019-11-30',
      isExpired: false
    });
  });

  it('handles a missing leading % without shifting fields', () => {
    const r = parseSouthAfricanLicenseDisc(DISC.slice(1), { today: '2019-11-01' });
    assert.ok(r);
    assert.strictEqual(r.plate, 'CJZ297GP');
    assert.strictEqual(r.regNumber, 'JYJ128C');
    assert.strictEqual(r.make, 'TOYOTA');
    assert.strictEqual(r.colour, 'White');
    assert.strictEqual(r.vin, 'AHTBB3QE300012345');
    assert.strictEqual(r.engineNumber, '2ZR1234567');
  });

  it('tolerates an AIM symbology prefix before the leading %', () => {
    const r = parseSouthAfricanLicenseDisc(`]L2${DISC}`, { today: '2019-11-01' });
    assert.strictEqual(r?.plate, 'CJZ297GP');
    assert.strictEqual(r?.engineNumber, '2ZR1234567');
  });

  it('accepts a lower-case mvl header and extra whitespace; strips spaces from the plate', () => {
    const r = parseSouthAfricanLicenseDisc(
      '%mvl1CC61% 0164 %4025T0HR%1%4025001C2GTP% cjz 297 gp %JYJ128C%Bakkie%FORD%RANGER%Silver%VIN1%ENG1%2027-04-30%',
      { today: '2026-09-30' }
    );
    assert.ok(r);
    assert.strictEqual(r.plate, 'CJZ297GP');
    assert.strictEqual(r.make, 'FORD');
    assert.strictEqual(r.isExpired, false);
  });

  it('leaves missing trailing fields undefined (never invents them)', () => {
    const r = parseSouthAfricanLicenseDisc('%MVL1CC61%0164%4025T0HR%1%4025001C2GTP%CJZ297GP%JYJ128C%Sedan', { today: '2026-09-30' });
    assert.ok(r);
    assert.strictEqual(r.plate, 'CJZ297GP');
    assert.strictEqual(r.description, 'Sedan');
    for (const key of ['make', 'model', 'colour', 'vin', 'engineNumber', 'expiryDate'] as const) {
      assert.strictEqual(r[key], undefined, key);
    }
    assert.strictEqual(r.isExpired, false);
    assert.strictEqual(discExpiryStatus(r), 'unknown');
  });

  it('returns an empty plate (not "UNKNOWN") when the plate field is empty', () => {
    const r = parseSouthAfricanLicenseDisc('%MVL1CC61%0164%4025T0HR%1%4025001C2GTP%%JYJ128C%', { today: '2026-09-30' });
    assert.ok(r);
    assert.strictEqual(r.plate, '');
  });

  it('ignores an impossible expiry date (2019-13-45) and uses the first valid one', () => {
    const bad = DISC.replace('2019-11-30', '2019-13-45');
    const r = parseSouthAfricanLicenseDisc(bad, { today: '2026-09-30' });
    assert.ok(r);
    assert.strictEqual(r.expiryDate, undefined);
    assert.strictEqual(r.isExpired, false);
    const two = parseSouthAfricanLicenseDisc(`${bad}2027-02-28%`, { today: '2026-09-30' });
    assert.strictEqual(two?.expiryDate, '2027-02-28');
  });

  it('rejects non-MVL payloads', () => {
    for (const raw of [
      '',
      'INVALID_TEXT_WITHOUT_DELIMITERS',
      'a%b%c%d%e%f%g%h%i%j',
      'ID%8001015009087%SMITH%JOHN%M%1980-01-01%ZA%RSA%X%Y%Z',
      '%ABC%1%2%3%4%5%6%7%8%9%10%MVL',
      'garbage%xx%MVL1%a%b%c%d%e%f',
      'PLAAS-CP:CP1',
      'https://example.org/?%MVL'
    ]) {
      assert.strictEqual(parseSouthAfricanLicenseDisc(raw), null, raw);
    }
    assert.strictEqual(parseSouthAfricanLicenseDisc(undefined as unknown as string), null);
  });

  describe('expiry in South African time (SAST)', () => {
    it('the expiry day itself is still valid; the next day is expired', () => {
      const disc = DISC.replace('2019-11-30', '2026-09-29');
      assert.strictEqual(parseSouthAfricanLicenseDisc(disc, { today: '2026-09-29' })?.isExpired, false);
      assert.strictEqual(parseSouthAfricanLicenseDisc(disc, { today: '2026-09-30' })?.isExpired, true);
    });

    it('uses the SAST date, not UTC: 00:30 SAST on 30 Sep is still 29 Sep in UTC (audit case)', () => {
      const disc = DISC.replace('2019-11-30', '2026-09-29');
      const halfPastMidnightSast = new Date('2026-09-29T22:30:00.000Z');
      assert.strictEqual(todayInSouthAfrica(halfPastMidnightSast), '2026-09-30');
      const r = parseSouthAfricanLicenseDisc(disc, { now: halfPastMidnightSast });
      assert.strictEqual(r?.isExpired, true);
      assert.strictEqual(discExpiryStatus(r!), 'expired');
      // 23:59 SAST on 29 Sep → still valid
      const r2 = parseSouthAfricanLicenseDisc(disc, { now: new Date('2026-09-29T21:59:00.000Z') });
      assert.strictEqual(r2?.isExpired, false);
      assert.strictEqual(discExpiryStatus(r2!), 'valid');
    });
  });
});

describe('date and plate helpers', () => {
  it('validates real calendar dates', () => {
    assert.strictEqual(isValidIsoDate('2024-02-29'), true);
    assert.strictEqual(isValidIsoDate('2023-02-29'), false);
    assert.strictEqual(isValidIsoDate('2019-13-45'), false);
    assert.strictEqual(isValidIsoDate('2019-00-10'), false);
    assert.strictEqual(isValidIsoDate('2019-1-10'), false);
  });

  it('checks plates loosely (warning only)', () => {
    assert.strictEqual(isValidSouthAfricanPlate('CA 123-456'), true);
    assert.strictEqual(isValidSouthAfricanPlate('GP 999-000'), true);
    assert.strictEqual(isValidSouthAfricanPlate('NW 12 AB GP'), true);
    assert.strictEqual(isValidSouthAfricanPlate('DAWIE GP'), true);
    assert.strictEqual(isValidSouthAfricanPlate('A'), false);
    assert.strictEqual(isValidSouthAfricanPlate('!!!!'), false);
    assert.strictEqual(isValidSouthAfricanPlate('VERYLONGLICENSEPLATE12345'), false);
    assert.strictEqual(plateFormatWarning('CJZ297GP'), null);
    assert.match(plateFormatWarning('PLAAS-CP:CP1') ?? '', /unusual characters/);
    assert.match(plateFormatWarning('') ?? '', /empty/);
    assert.match(plateFormatWarning('X'.repeat(60)) ?? '', /longer than 50/);
  });
});
