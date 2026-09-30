'use client';

import React from 'react';
import type { Site } from '@/types/models';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import { confidenceTone, formatSpan, LATE_UPLOAD_MS, personName, toMs, uploadDelayMs } from '../data/derive';
import type { PersonInfo, ScanRow } from '../data/types';
import { confidenceLabel, payloadLabel, payloadTone, TFn, TONE_TEXT } from './labels';
import { Chip, DividedList, EmptyLine, TimeCell } from './Primitives';

const GPS_ERRORS: Record<string, TranslationKey> = {
  permission_denied: 'supGpsErrPermission',
  timeout: 'supGpsErrTimeout',
  unavailable: 'supGpsErrUnavailable',
  unsupported: 'supGpsErrUnsupported',
  insecure: 'supGpsErrInsecure',
  stale: 'supGpsErrStale'
};

/** Phone-reported position of a scan relative to its checkpoint, in words. */
export function scanGpsDetail(t: TFn, scan: ScanRow): string {
  if (scan.gps_confidence === 'no_fix' || (scan.distance_to_checkpoint_meters === null && scan.gps_error)) {
    const key = scan.gps_error ? GPS_ERRORS[scan.gps_error] : undefined;
    return key ? t(key) : t('supGpsNoFix');
  }
  if (scan.gps_confidence === 'no_reference') return t('supGpsNoReferenceDetail');
  if (scan.distance_to_checkpoint_meters === null) return t('supGpsUnknown');
  return t(
    'supGpsDistance',
    Math.round(scan.distance_to_checkpoint_meters),
    scan.accuracy_meters !== null ? Math.round(scan.accuracy_meters) : '?',
    scan.checkpoint_radius_meters ?? '?'
  );
}

export function ScanList({
  scans,
  checkpointNames,
  people,
  sites,
  showSite,
  now,
  limit,
  testId
}: {
  scans: readonly ScanRow[];
  checkpointNames: ReadonlyMap<string, string>;
  people: Readonly<Record<string, PersonInfo>>;
  sites: ReadonlyMap<string, Site>;
  showSite: boolean;
  now: number;
  limit: number;
  testId: string;
}) {
  const { t } = useTranslation();
  const rows = [...scans]
    .sort((a, b) => (toMs(b.scan_timestamp_device) ?? 0) - (toMs(a.scan_timestamp_device) ?? 0))
    .slice(0, limit);
  if (rows.length === 0) return <EmptyLine testId={`${testId}-empty`}>{t('supNoScans')}</EmptyLine>;

  return (
    <DividedList testId={testId}>
      {rows.map((scan) => {
        const delay = uploadDelayMs(scan);
        const tone = confidenceTone(scan.gps_confidence);
        const site = scan.site_id ? sites.get(scan.site_id) : undefined;
        return (
          <li key={scan.id} className="flex gap-3 px-3 py-2.5" data-testid={`${testId}-row`}>
            <TimeCell ms={toMs(scan.scan_timestamp_device)} now={now} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words font-semibold text-ee-text">
                  {checkpointNames.get(scan.checkpoint_id) ?? t('supUnknownCheckpoint')}
                </span>
                <Chip tone={tone} data-testid={`${testId}-gps`}>
                  {confidenceLabel(t, scan.gps_confidence)}
                </Chip>
              </div>
              <p className="text-sm text-ee-muted">
                {personName(people, scan.guard_id) ?? t('supUnknownPerson')}
                {showSite && site ? ` · ${site.name}` : ''}
              </p>
              <p className={`text-xs ${TONE_TEXT[tone === 'success' ? 'muted' : tone]}`}>{scanGpsDetail(t, scan)}</p>
              <p className="flex flex-wrap gap-x-3 text-xs">
                <span className={TONE_TEXT[payloadTone(scan.payload_type, scan.payload_verified)]}>
                  {payloadLabel(t, scan.payload_type, scan.payload_verified)}
                </span>
                {delay !== null && delay >= LATE_UPLOAD_MS && (
                  <span className="text-ee-warning">{t('supUploadedLater', formatSpan(delay))}</span>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </DividedList>
  );
}
