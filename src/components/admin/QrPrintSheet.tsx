'use client';

/**
 * Printable checkpoint QR cards (Dawie's layout: two cards per row, dashed cut lines, 60 mm
 * code). Rendered only for print (`hidden print:block`); the admin screen itself is marked
 * print:hidden. Cards are printed black on white paper: that is what a phone camera reads
 * reliably, so this sheet deliberately does not use the dark screen theme.
 */
import React, { useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { useTranslation } from '@/lib/i18n/context';

export interface PrintCard {
  checkpointId: string;
  name: string;
  siteName: string;
  orderIndex: number;
  /** Last characters of the token, to tell a reprint from an old (revoked) card. */
  cardRef: string;
  /** PNG data URL of the QR code encoding the checkpoint token. */
  dataUrl: string;
}

export interface PrintJob {
  id: number;
  cards: PrintCard[];
}

/** QR image for a checkpoint token: error correction M, 4-module quiet zone. */
export function makeQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 4, width: 512 });
}

export function QrPrintSheet({ job }: { job: PrintJob | null }) {
  const { t } = useTranslation();
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!job) return;
    let cancelled = false;
    const images = Array.from(sheetRef.current?.querySelectorAll('img') ?? []);
    void Promise.all(images.map((img) => img.decode().catch(() => undefined))).then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
    };
  }, [job]);

  if (!job) return null;
  return (
    <div ref={sheetRef} className="hidden print:block bg-white text-black" data-testid="admin-print-sheet" aria-hidden="true">
      <div className="grid grid-cols-2 gap-[14mm] p-[8mm]">
        {job.cards.map((card) => (
          <div key={card.checkpointId} className="break-inside-avoid border-2 border-dashed border-black p-[8mm] text-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URL generated on this device */}
            <img src={card.dataUrl} alt="" className="mx-auto h-[60mm] w-[60mm]" />
            <p className="mt-[4mm] font-display text-[24pt] font-bold leading-tight">{card.name}</p>
            <p className="text-[11pt]">{card.siteName}</p>
            <p className="mt-[2mm] text-[9pt]">{t('admCardFooter', card.orderIndex, card.cardRef)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
