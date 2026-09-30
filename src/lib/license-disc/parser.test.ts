import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSouthAfricanLicenseDisc, isValidSouthAfricanPlate } from './parser';

describe('South African License Disc Parser', () => {
  it('parses valid MVL barcode string accurately', () => {
    // Standard South African MVL string format
    const sampleBarcode = '%MVL%1%SEDAN%01%2027-04-30%CA 123-456%987654321%SEDAN%TOYOTA%COROLLA%WHITE%A1B2C3D4E5F6G7H8I%123456789%';
    const result = parseSouthAfricanLicenseDisc(sampleBarcode);

    assert.ok(result !== null);
    assert.strictEqual(result.plate, 'CA123-456');
    assert.strictEqual(result.make, 'TOYOTA');
    assert.strictEqual(result.model, 'COROLLA');
    assert.strictEqual(result.colour, 'WHITE');
    assert.strictEqual(result.vin, 'A1B2C3D4E5F6G7H8I');
    assert.strictEqual(result.expiryDate, '2027-04-30');
    assert.strictEqual(result.isExpired, false);
  });

  it('detects expired licence discs', () => {
    const expiredBarcode = '%MVL%1%SEDAN%01%2020-01-01%GP 999-000%987654321%BAKKIE%FORD%RANGER%SILVER%VIN123456%ENG98765%';
    const result = parseSouthAfricanLicenseDisc(expiredBarcode);

    assert.ok(result !== null);
    assert.strictEqual(result.isExpired, true);
  });

  it('handles null or invalid barcodes safely', () => {
    assert.strictEqual(parseSouthAfricanLicenseDisc(''), null);
    assert.strictEqual(parseSouthAfricanLicenseDisc('INVALID_TEXT_WITHOUT_DELIMITERS'), null);
  });

  it('validates South African licence plates correctly', () => {
    assert.strictEqual(isValidSouthAfricanPlate('CA 123-456'), true);
    assert.strictEqual(isValidSouthAfricanPlate('GP 999-000'), true);
    assert.strictEqual(isValidSouthAfricanPlate('NW 12 AB GP'), true);
    assert.strictEqual(isValidSouthAfricanPlate('A'), false);
    assert.strictEqual(isValidSouthAfricanPlate('VERYLONGLICENSEPLATE12345'), false);
  });
});
