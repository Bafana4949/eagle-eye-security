import { buildWhatsAppLink, copySummaryToClipboard } from './summary';

/**
 * Designated WhatsApp Dispatch Number for all vehicle licence disc scans (IN and OUT)
 */
export const GATE_DISPATCH_WHATSAPP_NUMBER = '0660179070';

export interface VehicleNotificationData {
  direction: 'in' | 'out';
  licensePlate: string;
  makeModel?: string;
  vehicleColour?: string;
  vinNumber?: string;
  engineNumber?: string;
  discExpiryDate?: string;
  isDiscExpired?: boolean;
  isDiscScanned?: boolean;
  driverName?: string;
  driverPhone?: string;
  company?: string;
  visitReason?: string;
  entryTime?: string;
  exitTime?: string;
  dwellDurationSeconds?: number;
  guardName?: string;
  siteName?: string;
}

/**
 * Formats scanned vehicle licence disc information into a structured, professional WhatsApp message
 * Uses standard, highly-compatible Unicode emojis recognized by all WhatsApp clients
 */
export function formatVehicleWhatsAppMessage(data: VehicleNotificationData): string {
  const isEntry = data.direction === 'in';
  const isoTime = isEntry ? (data.entryTime || new Date().toISOString()) : (data.exitTime || new Date().toISOString());
  
  let formattedTime = isoTime;
  try {
    formattedTime = new Date(isoTime).toLocaleString('en-ZA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    // fallback
  }

  let dwellText = '';
  if (!isEntry && data.dwellDurationSeconds !== undefined) {
    const mins = Math.max(1, Math.round(data.dwellDurationSeconds / 60));
    if (mins >= 60) {
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      dwellText = `${hours}h ${remMins}m`;
    } else {
      dwellText = `${mins} min${mins === 1 ? '' : 's'}`;
    }
  }

  const lines: string[] = [
    '🦅 EAGLE EYE SECURITY — VEHICLE ACCESS LOG',
    '====================================',
    `🚗 MOVEMENT: ${isEntry ? 'ENTRY [ IN ] 🟢' : 'EXIT [ OUT ] 🔴'}`,
    `🔖 REG / PLATE: ${data.licensePlate.toUpperCase().trim()}`
  ];

  if (data.makeModel) {
    lines.push(`🚘 MAKE & MODEL: ${data.makeModel.trim()}`);
  }
  if (data.vehicleColour) {
    lines.push(`🎨 COLOUR: ${data.vehicleColour.trim()}`);
  }

  if (data.discExpiryDate) {
    const status = data.isDiscExpired ? '⚠️ EXPIRED' : '✅ VALID';
    lines.push(`📋 LICENCE DISC: ${data.discExpiryDate} (${status})`);
  } else if (data.isDiscScanned) {
    lines.push(`📋 LICENCE DISC: SCANNED`);
  }

  if (data.vinNumber) {
    lines.push(`🔢 VIN: ${data.vinNumber.trim()}`);
  }
  if (data.engineNumber) {
    lines.push(`🔧 ENGINE NO: ${data.engineNumber.trim()}`);
  }

  if (data.driverName || data.driverPhone) {
    const driverContact = [data.driverName, data.driverPhone].filter(Boolean).join(' · ');
    lines.push(`👤 DRIVER: ${driverContact}`);
  }

  if (data.company || data.visitReason) {
    const visitDetails = [data.company, data.visitReason].filter(Boolean).join(' - ');
    lines.push(`🏢 PURPOSE / CO: ${visitDetails}`);
  }

  lines.push(`⏰ TIME: ${formattedTime}`);

  if (dwellText) {
    lines.push(`⏳ TIME ON PREMISES: ${dwellText}`);
  }

  if (data.guardName) {
    lines.push(`👮 GUARD: ${data.guardName}`);
  }

  if (data.siteName) {
    lines.push(`📍 SITE: ${data.siteName}`);
  }

  lines.push('====================================');
  lines.push('🔒 Aiguille Security & Dawie Boerdery');

  return lines.join('\n');
}

/**
 * Generates direct WhatsApp send link with encoded text message for the vehicle log
 */
export function buildVehicleWhatsAppUrl(
  data: VehicleNotificationData,
  targetPhone: string = GATE_DISPATCH_WHATSAPP_NUMBER
): string {
  const message = formatVehicleWhatsAppMessage(data);
  return buildWhatsAppLink(targetPhone, message);
}

/**
 * Copies formatted vehicle message directly to device clipboard
 */
export async function copyVehicleTextToClipboard(data: VehicleNotificationData): Promise<boolean> {
  const message = formatVehicleWhatsAppMessage(data);
  return copySummaryToClipboard(message);
}
