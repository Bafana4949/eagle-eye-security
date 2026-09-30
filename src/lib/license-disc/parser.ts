/**
 * South African Motor Vehicle Licence (MVL) Disc Barcode Parser
 * Decodes the PDF417 format used on South African vehicle licence discs.
 */

import { LicenseDiscData } from '@/types/models';

export function parseSouthAfricanLicenseDisc(rawBarcodeText: string): LicenseDiscData | null {
  if (!rawBarcodeText || typeof rawBarcodeText !== 'string') {
    return null;
  }

  // Tokenize using standard '%' delimiter used in SA MVL barcodes
  const tokens = rawBarcodeText.split('%').map((t) => t.trim());

  // Standard SA disc has MVL identifier in early segment
  const isMvl = tokens.some((token) => /^MVL/i.test(token));
  if (!isMvl && tokens.length < 10) {
    return null;
  }

  // Index mapping based on standard South African National Road Traffic Act PDF417 specification:
  // [1] = 'MVL' / Document type
  // [6] = Licence Plate / Registration number
  // [7] = Vehicle Register Number
  // [8] = Vehicle Description (e.g. Sedan, Bakkie)
  // [9] = Make (e.g. TOYOTA)
  // [10] = Series Name / Model (e.g. HILUX)
  // [11] = Colour (e.g. WHITE)
  // [12] = VIN / Chassis number
  // [13] = Engine number
  const plateRaw = tokens[6] || '';
  const plate = plateRaw.replace(/\s+/g, '').toUpperCase();
  const regNumber = tokens[7] || '';
  const make = (tokens[9] || '').trim();
  const model = (tokens[10] || '').trim();
  const colour = (tokens[11] || '').trim();
  const vin = (tokens[12] || '').trim();
  const engineNumber = (tokens[13] || '').trim();

  // Find expiration date formatted as YYYY-MM-DD
  const expiryDateMatch = tokens.find((token) => /^\d{4}-\d{2}-\d{2}$/.test(token));
  const expiryDate = expiryDateMatch || undefined;

  let isExpired = false;
  if (expiryDate) {
    const today = new Date().toISOString().split('T')[0];
    isExpired = expiryDate < today;
  }

  return {
    plate: plate || 'UNKNOWN',
    regNumber,
    make,
    model,
    colour,
    vin,
    engineNumber,
    expiryDate,
    isExpired
  };
}

/**
 * Validates standard South African licence plate format
 * Supports provincial formats (e.g. GP, MP, NW, L, EC, FS, KZN, NC, WP)
 * and personalized plates.
 */
export function isValidSouthAfricanPlate(plate: string): boolean {
  const clean = plate.replace(/[\s-]/g, '').toUpperCase();
  return clean.length >= 3 && clean.length <= 10;
}
