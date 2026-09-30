import { describe, it } from 'node:test';
import assert from 'node:assert';
import { 
  formatWhatsAppShiftSummary, 
  sanitizeWhatsAppNumber, 
  buildWhatsAppLink,
  ShiftSummaryData 
} from './summary';

describe('WhatsApp Shift Summary Utility', () => {
  const sampleData: ShiftSummaryData = {
    siteName: 'Dawie Boerdery - Hoofplaas',
    guardName: 'Sipho Khoza',
    shiftType: 'Night Shift',
    dateStr: '2026-09-30',
    shiftStartTime: '18:00',
    shiftEndTime: '06:00',
    completedRounds: 12,
    totalRounds: 12,
    visitedCheckpoints: 72,
    totalExpectedCheckpoints: 72,
    longestGapFormatted: '38m',
    incidentCount: 1,
    vehiclesIn: 5,
    vehiclesOut: 5,
    sosAlertCount: 0,
    syncStatus: 'All records synchronized',
    referenceId: 'SHIFT-2026-881920'
  };

  it('formats a complete professional WhatsApp shift summary', () => {
    const summary = formatWhatsAppShiftSummary(sampleData);

    assert.ok(summary.includes('EAGLE EYE SECURITY — SHIFT SUMMARY'));
    assert.ok(summary.includes('Dawie Boerdery - Hoofplaas'));
    assert.ok(summary.includes('Sipho Khoza'));
    assert.ok(summary.includes('Night Shift (18:00 – 06:00)'));
    assert.ok(summary.includes('Rounds Completed: 12 / 12 (100%)'));
    assert.ok(summary.includes('Checkpoint Scans: 72 / 72'));
    assert.ok(summary.includes('Longest Gap: 38m'));
    assert.ok(summary.includes('Incidents Reported: 1'));
    assert.ok(summary.includes('Vehicles Logged In: 5'));
    assert.ok(summary.includes('Vehicles Logged Out: 5'));
    assert.ok(summary.includes('SOS Panic Dispatches: 0'));
    assert.ok(summary.includes('Status: All records synchronized'));
    assert.ok(summary.includes('Reference: SHIFT-2026-881920'));
  });

  it('sanitizes South African domestic phone numbers to international format', () => {
    assert.strictEqual(sanitizeWhatsAppNumber('082 123 4567'), '27821234567');
    assert.strictEqual(sanitizeWhatsAppNumber('+27 82 123 4567'), '27821234567');
    assert.strictEqual(sanitizeWhatsAppNumber('27821234567'), '27821234567');
    assert.strictEqual(sanitizeWhatsAppNumber('+27-82-999-4321'), '27829994321');
  });

  it('builds a valid wa.me URL with prefilled message', () => {
    const url = buildWhatsAppLink('+27 82 123 4567', 'Hello Dawie');
    assert.strictEqual(url, 'https://wa.me/27821234567?text=Hello%20Dawie');
  });

  it('handles zero checkpoints gracefully without division by zero', () => {
    const emptyData: ShiftSummaryData = {
      ...sampleData,
      visitedCheckpoints: 0,
      totalExpectedCheckpoints: 0,
      completedRounds: 0,
      totalRounds: 0
    };

    const summary = formatWhatsAppShiftSummary(emptyData);
    assert.ok(summary.includes('100%'));
  });
});
