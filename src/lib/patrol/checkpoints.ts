import { Checkpoint } from '@/types/models';

export const DAWIE_FARM_CHECKPOINTS: Checkpoint[] = [
  {
    id: 'b6ebff4c-3d2f-4abb-a899-2b2f96c0beca',
    siteId: '22222222-2222-2222-2222-222222222222',
    name: 'Hoofhek / Main Gate',
    description: 'Vehicle access gate and boom control point (CP1)',
    qrCodeHash: 'EE-CP-MAIN-GATE-01',
    nfcUid: '04:7A:B2:C1',
    latitude: -25.684120,
    longitude: 27.814520,
    permittedRadiusMeters: 50,
    orderIndex: 1,
    isActive: true
  },
  {
    id: '374c0a41-ea13-4b71-9597-71ff29b20636',
    siteId: '22222222-2222-2222-2222-222222222222',
    name: 'Skaapkraal / Sheep Kraal',
    description: 'East livestock pen boundary (CP2)',
    qrCodeHash: 'EE-CP-SHEEP-KRAAL-02',
    nfcUid: '04:7A:B2:C2',
    latitude: -25.684890,
    longitude: 27.815210,
    permittedRadiusMeters: 60,
    orderIndex: 2,
    isActive: true
  },
  {
    id: 'dfc0cad1-010f-440d-a535-23f98afe2c53',
    siteId: '22222222-2222-2222-2222-222222222222',
    name: 'Hoenderhok / Poultry Sheds',
    description: 'Northern poultry enclosures (CP3)',
    qrCodeHash: 'EE-CP-POULTRY-SHED-03',
    nfcUid: '04:7A:B2:C3',
    latitude: -25.683500,
    longitude: 27.814010,
    permittedRadiusMeters: 50,
    orderIndex: 3,
    isActive: true
  },
  {
    id: 'ec8fd70a-4da0-4af5-a52f-03f78dac5a42',
    siteId: '22222222-2222-2222-2222-222222222222',
    name: 'Stoor & Werkswinkel / Workshop',
    description: 'Equipment depot and diesel storage (CP4)',
    qrCodeHash: 'EE-CP-WORKSHOP-04',
    nfcUid: '04:7A:B2:C4',
    latitude: -25.684300,
    longitude: 27.813800,
    permittedRadiusMeters: 50,
    orderIndex: 4,
    isActive: true
  },
  {
    id: '060fee61-5312-453d-a761-46585c82d074',
    siteId: '22222222-2222-2222-2222-222222222222',
    name: 'Skadunet-tuin / Shade Garden',
    description: 'Hydroponics and vegetable tunnel (CP5)',
    qrCodeHash: 'EE-CP-SHADE-GARDEN-05',
    nfcUid: '04:7A:B2:C5',
    latitude: -25.685100,
    longitude: 27.814900,
    permittedRadiusMeters: 50,
    orderIndex: 5,
    isActive: true
  },
  {
    id: 'cd6b0791-81b6-42b6-b182-57821c74afb1',
    siteId: '22222222-2222-2222-2222-222222222222',
    name: 'Grensdraad Noord / North Fence',
    description: 'Perimeter fence beacon north (CP6)',
    qrCodeHash: 'EE-CP-NORTH-FENCE-06',
    nfcUid: '04:7A:B2:C6',
    latitude: -25.682900,
    longitude: 27.814300,
    permittedRadiusMeters: 75,
    orderIndex: 6,
    isActive: true
  }
];

/**
 * Universal matcher for scanning QR cards and NFC tokens:
 * Supports:
 * 1. Printed physical QR cards from PDF ("PLAAS-CP:CP1", "PLAAS-CP:CP2", ... "PLAAS-CP:CP6")
 * 2. Short forms ("CP1", "CP2", ... "CP6", "1", "2")
 * 3. Modern cryptographic hashes ("EE-CP-MAIN-GATE-01")
 * 4. NFC Serial / UIDs ("04:7A:B2:C1", "047AB2C1")
 * 5. Checkpoint UUIDs and fuzzy name matching
 */
export function matchCheckpoint(
  scannedText: string,
  checkpoints: Checkpoint[]
): Checkpoint | undefined {
  if (!scannedText || typeof scannedText !== 'string') return undefined;

  const clean = scannedText.trim();
  const upper = clean.toUpperCase();
  const normalizedClean = clean.replace(/[:\-_ ]/g, '').toUpperCase();

  // 1. Exact or partial match on qrCodeHash
  let match = checkpoints.find(
    (c) =>
      c.qrCodeHash === clean ||
      clean.includes(c.qrCodeHash) ||
      c.qrCodeHash.toUpperCase() === upper
  );
  if (match) return match;

  // 2. Physical PDF cards & legacy format: "PLAAS-CP:CP1" -> "PLAAS-CP:CP6"
  // Extracts the checkpoint number 1-6
  const numMatch =
    upper.match(/PLAAS-CP:CP(\d+)/i) ||
    upper.match(/PLAAS-CP:(\d+)/i) ||
    upper.match(/^CP(\d+)$/i) ||
    upper.match(/^(\d+)$/);

  if (numMatch) {
    const orderNum = parseInt(numMatch[1], 10);
    match = checkpoints.find(
      (c) =>
        c.orderIndex === orderNum ||
        c.id === `CP${orderNum}` ||
        c.description?.includes(`CP${orderNum}`) ||
        c.name.toLowerCase().includes(`cp${orderNum}`)
    );
    if (match) return match;
  }

  // 3. Match by ID or Order Index directly
  match = checkpoints.find(
    (c) =>
      c.id === clean ||
      c.id.toLowerCase() === clean.toLowerCase() ||
      clean.endsWith(c.id) ||
      clean.includes(c.id) ||
      (c.orderIndex &&
        (clean === `CP${c.orderIndex}` ||
          clean === `PLAAS-CP:CP${c.orderIndex}` ||
          clean === `PLAAS-CP:${c.orderIndex}`))
  );
  if (match) return match;

  // 4. Match by NFC UID (colon-separated or raw hex)
  match = checkpoints.find((c) => {
    if (!c.nfcUid) return false;
    const cleanNfc = c.nfcUid.replace(/[:\-_ ]/g, '').toUpperCase();
    return c.nfcUid === clean || cleanNfc === normalizedClean;
  });
  if (match) return match;

  // 5. Match by Name fuzzy match
  match = checkpoints.find((c) => {
    const cleanName = c.name.toLowerCase();
    const cleanInput = clean.toLowerCase();
    return (
      cleanName.includes(cleanInput) ||
      cleanInput.includes(cleanName.split('/')[0].trim().toLowerCase())
    );
  });

  return match;
}
