/**
 * WhatsApp Shift & Patrol Summary Generator
 * Formats a concise, professional operational report and generates
 * secure wa.me pre-filled dispatch links for site supervisors and farm managers.
 */

export interface ShiftSummaryData {
  siteName: string;
  guardName: string;
  shiftType: 'Day Shift' | 'Night Shift';
  dateStr: string;
  shiftStartTime: string;
  shiftEndTime: string;
  completedRounds: number;
  totalRounds: number;
  visitedCheckpoints: number;
  totalExpectedCheckpoints: number;
  longestGapFormatted: string;
  incidentCount: number;
  vehiclesIn: number;
  vehiclesOut: number;
  sosAlertCount: number;
  syncStatus: 'All records synchronized' | 'Pending offline records' | string;
  referenceId: string;
}

/**
 * Formats operational shift data into a clean, professional WhatsApp text block
 */
export function formatWhatsAppShiftSummary(data: ShiftSummaryData): string {
  const compliancePct = data.totalExpectedCheckpoints > 0
    ? Math.round((data.visitedCheckpoints / data.totalExpectedCheckpoints) * 100)
    : (data.totalRounds > 0 ? Math.round((data.completedRounds / data.totalRounds) * 100) : 100);

  return [
    '🦅 EAGLE EYE SECURITY — SHIFT SUMMARY',
    '====================================',
    `📍 Site: ${data.siteName}`,
    `🛡️ Guard: ${data.guardName}`,
    `⏰ Shift: ${data.shiftType} (${data.shiftStartTime} – ${data.shiftEndTime})`,
    `📅 Date: ${data.dateStr}`,
    '',
    '📊 PATROL COMPLIANCE:',
    `• Rounds Completed: ${data.completedRounds} / ${data.totalRounds} (${compliancePct}%)`,
    `• Checkpoint Scans: ${data.visitedCheckpoints} / ${data.totalExpectedCheckpoints}`,
    `• Longest Gap: ${data.longestGapFormatted}`,
    '',
    '🚨 GATE & INCIDENT ACTIVITY:',
    `• Incidents Reported: ${data.incidentCount}`,
    `• Vehicles Logged In: ${data.vehiclesIn}`,
    `• Vehicles Logged Out: ${data.vehiclesOut}`,
    `• SOS Panic Dispatches: ${data.sosAlertCount}`,
    '',
    '🔄 SYNC & INTEGRITY:',
    `• Status: ${data.syncStatus}`,
    `• Reference: ${data.referenceId}`,
    '===================================='
  ].join('\n');
}

/**
 * Sanitizes phone number to international format (digits only, e.g. 27821234567)
 */
export function sanitizeWhatsAppNumber(phone: string): string {
  let cleaned = phone.replace(/\D/g, '');
  // If started with 0 (e.g. 082 123 4567) in South Africa, convert to 27
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = '27' + cleaned.slice(1);
  }
  return cleaned;
}

/**
 * Generates direct wa.me link with encoded text message
 */
export function buildWhatsAppLink(rawPhone: string, message: string): string {
  const phone = sanitizeWhatsAppNumber(rawPhone);
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

/**
 * Copies summary text to user clipboard
 */
export async function copySummaryToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }

  // Fallback for older web contexts
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textarea);
    return successful;
  } catch {
    return false;
  }
}
