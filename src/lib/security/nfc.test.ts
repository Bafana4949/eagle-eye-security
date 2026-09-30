import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Validates checkpoint tokens (supports new secure cryptotokens and Dawie legacy PLAAS-CP)
 */
function isValidCheckpointToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const clean = token.trim();
  // Format 1: New secure crypto token (EE-CP-XXXX, EE-CP-MAIN-GATE, etc.)
  if (/^EE-CP-[A-Z0-9_-]{4,}$/i.test(clean)) return true;
  // Format 2: Dawie legacy format (PLAAS-CP:CP1, PLAAS-CP:1)
  if (/^PLAAS-CP:[A-Z0-9_-]+$/i.test(clean)) return true;
  // Format 3: NFC Serial identifier or Tag UID
  if (/^[a-f0-9:]{8,}$/i.test(clean)) return true;
  return false;
}

/**
 * Evaluates hardware compatibility based on platform and tag technology
 */
function evaluateHardwareCompatibility(platform: 'android' | 'ios' | 'desktop', tagType: '13.56mhz_ndef' | '125khz_rfid' | 'qr_code') {
  if (tagType === 'qr_code') {
    return { isSupported: true, method: 'camera', note: 'Supported across all smartphones via camera' };
  }

  if (tagType === '125khz_rfid') {
    return {
      isSupported: false,
      method: 'unsupported',
      note: '125 kHz low-frequency RFID tags cannot be read by browser Web NFC. Use compatible 13.56 MHz NFC tags or QR cards.'
    };
  }

  if (platform === 'ios') {
    return {
      isSupported: false,
      method: 'qr_fallback',
      note: 'Web NFC API is not exposed on iOS Safari. Automatic fallback to QR checkpoint cards.'
    };
  }

  if (platform === 'android' && tagType === '13.56mhz_ndef') {
    return {
      isSupported: true,
      method: 'web_nfc',
      note: 'Fully supported in Google Chrome via NDEFReader API'
    };
  }

  return { isSupported: false, method: 'unknown', note: 'Testing required' };
}

describe('NFC & Checkpoint Token Validation', () => {
  it('validates secure random checkpoint tokens', () => {
    assert.strictEqual(isValidCheckpointToken('EE-CP-A1B2C3D4'), true);
    assert.strictEqual(isValidCheckpointToken('EE-CP-MAIN-GATE-01'), true);
    assert.strictEqual(isValidCheckpointToken('EE-CP-PUMPSTATION_2'), true);
  });

  it('validates Dawie legacy PLAAS-CP checkpoint cards', () => {
    assert.strictEqual(isValidCheckpointToken('PLAAS-CP:CP1'), true);
    assert.strictEqual(isValidCheckpointToken('PLAAS-CP:CP6'), true);
    assert.strictEqual(isValidCheckpointToken('PLAAS-CP:MAIN'), true);
  });

  it('validates NFC serial numbers', () => {
    assert.strictEqual(isValidCheckpointToken('04:5f:a2:b1:9c:60:80'), true);
    assert.strictEqual(isValidCheckpointToken('045fa2b19c6080'), true);
  });

  it('rejects invalid or empty tokens', () => {
    assert.strictEqual(isValidCheckpointToken(''), false);
    assert.strictEqual(isValidCheckpointToken('123'), false);
    assert.strictEqual(isValidCheckpointToken('unknown-token'), false);
  });

  it('enforces proper hardware compatibility matrix', () => {
    // Android + 13.56MHz NDEF tag
    const androidNfc = evaluateHardwareCompatibility('android', '13.56mhz_ndef');
    assert.strictEqual(androidNfc.isSupported, true);
    assert.strictEqual(androidNfc.method, 'web_nfc');

    // iOS + NFC tag
    const iosNfc = evaluateHardwareCompatibility('ios', '13.56mhz_ndef');
    assert.strictEqual(iosNfc.isSupported, false);
    assert.strictEqual(iosNfc.method, 'qr_fallback');

    // 125kHz RFID button
    const rfid125 = evaluateHardwareCompatibility('android', '125khz_rfid');
    assert.strictEqual(rfid125.isSupported, false);
    assert.strictEqual(rfid125.method, 'unsupported');

    // QR checkpoint cards across all platforms
    const qrAndroid = evaluateHardwareCompatibility('android', 'qr_code');
    const qrIos = evaluateHardwareCompatibility('ios', 'qr_code');
    assert.strictEqual(qrAndroid.isSupported, true);
    assert.strictEqual(qrIos.isSupported, true);
  });
});
