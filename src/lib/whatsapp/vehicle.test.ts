import { describe, it } from 'node:test';
import assert from 'node:assert';
import { 
  formatVehicleWhatsAppMessage, 
  buildVehicleWhatsAppUrl, 
  GATE_DISPATCH_WHATSAPP_NUMBER 
} from './vehicle';

describe('Vehicle WhatsApp Dispatch to 0660179070', () => {
  it('correctly uses target phone number 0660179070', () => {
    assert.strictEqual(GATE_DISPATCH_WHATSAPP_NUMBER, '0660179070');
  });

  it('formats entry of a scanned vehicle disc accurately', () => {
    const text = formatVehicleWhatsAppMessage({
      direction: 'in',
      licensePlate: 'CA 123-456',
      makeModel: 'TOYOTA HILUX',
      vehicleColour: 'WHITE',
      vinNumber: 'AHTFR22G901234567',
      engineNumber: '2KD1234567',
      discExpiryDate: '2026-11-30',
      isDiscExpired: false,
      isDiscScanned: true,
      driverName: 'Kobus van der Merwe',
      driverPhone: '082 123 4567',
      company: 'AgriFeed Supplies',
      visitReason: 'Fertilizer Delivery',
      guardName: 'Sipho Khoza',
      siteName: 'Dawie Boerdery - Hoofhek'
    });

    assert.ok(text.includes('EAGLE EYE SECURITY — VEHICLE ACCESS LOG'));
    assert.ok(text.includes('ENTRY [ IN ] 🟢'));
    assert.ok(text.includes('CA 123-456'));
    assert.ok(text.includes('TOYOTA HILUX'));
    assert.ok(text.includes('WHITE'));
    assert.ok(text.includes('2026-11-30 (✅ VALID)'));
    assert.ok(text.includes('AHTFR22G901234567'));
    assert.ok(text.includes('2KD1234567'));
    assert.ok(text.includes('Kobus van der Merwe'));
    assert.ok(text.includes('AgriFeed Supplies - Fertilizer Delivery'));
    assert.ok(text.includes('Sipho Khoza'));
    assert.ok(text.includes('Dawie Boerdery - Hoofhek'));
  });

  it('formats vehicle exit with dwell duration', () => {
    const text = formatVehicleWhatsAppMessage({
      direction: 'out',
      licensePlate: 'WP 987 MP',
      makeModel: 'ISUZU D-MAX',
      vehicleColour: 'SILVER',
      dwellDurationSeconds: 3720, // ~1h 2m
      guardName: 'Petrus Ndlovu',
      siteName: 'Dawie Boerdery'
    });

    assert.ok(text.includes('EXIT [ OUT ] 🔴'));
    assert.ok(text.includes('WP 987 MP'));
    assert.ok(text.includes('ISUZU D-MAX'));
    assert.ok(text.includes('TIME ON PREMISES: 1h 2m'));
    assert.ok(text.includes('Petrus Ndlovu'));
  });

  it('generates a direct WhatsApp URL with 27660179070', () => {
    const url = buildVehicleWhatsAppUrl({
      direction: 'in',
      licensePlate: 'ABC 123 GP'
    });

    assert.ok(url.startsWith('https://api.whatsapp.com/send?phone=27660179070&text='));
    assert.ok(url.includes(encodeURIComponent('ABC 123 GP')));
    assert.ok(url.includes(encodeURIComponent('ENTRY [ IN ] 🟢')));
  });
});
