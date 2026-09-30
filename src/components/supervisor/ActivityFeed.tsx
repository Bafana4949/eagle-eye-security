'use client';

import React from 'react';
import { AlertTriangle, Car, LogIn, LogOut, ScanLine, Siren } from 'lucide-react';
import type { Site } from '@/types/models';
import { useTranslation } from '@/lib/i18n/context';
import { personName, type ActivityItem, type ActivityKind } from './data/derive';
import type { PersonInfo } from './data/types';
import { confidenceLabel, incidentTypeLabel, TFn, TONE_TEXT } from './ui/labels';
import { Chip, DividedList, EmptyLine, TimeCell } from './ui/Primitives';

/** Short description of an activity item ("Scanned Dam", "Vehicle in: CA 123"). */
export function activityText(t: TFn, item: ActivityItem): string {
  switch (item.kind) {
    case 'scan':
      return t('supActScan', item.detail ?? t('supUnknownCheckpoint'));
    case 'incident':
      return t('supActIncident', item.detail ? incidentTypeLabel(t, item.detail) : '');
    case 'panic':
      return t('supActSos');
    case 'gate_in':
      return t('supActGateIn', item.detail ?? '');
    case 'gate_out':
      return t('supActGateOut', item.detail ?? '');
    case 'shift_start':
      return t('supActClockIn');
    case 'shift_end':
      return t('supActClockOut');
  }
}

const ICONS: Record<ActivityKind, React.ReactNode> = {
  scan: <ScanLine className="h-4 w-4" aria-hidden="true" />,
  incident: <AlertTriangle className="h-4 w-4" aria-hidden="true" />,
  panic: <Siren className="h-4 w-4" aria-hidden="true" />,
  gate_in: <Car className="h-4 w-4" aria-hidden="true" />,
  gate_out: <Car className="h-4 w-4" aria-hidden="true" />,
  shift_start: <LogIn className="h-4 w-4" aria-hidden="true" />,
  shift_end: <LogOut className="h-4 w-4" aria-hidden="true" />
};

/** Latest events that reached the server, newest first (times are the phone's record time). */
export function ActivityFeed({
  items,
  people,
  sites,
  showSite,
  now
}: {
  items: readonly ActivityItem[];
  people: Readonly<Record<string, PersonInfo>>;
  sites: ReadonlyMap<string, Site>;
  showSite: boolean;
  now: number;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return <EmptyLine testId="supervisor-activity-empty">{t('supNoActivity')}</EmptyLine>;
  return (
    <DividedList testId="supervisor-activity">
      {items.map((item) => (
        <li key={item.key} className="flex gap-3 px-3 py-2" data-testid="supervisor-activity-row" data-kind={item.kind}>
          <TimeCell ms={item.at} now={now} />
          <div className="min-w-0 flex-1">
            <p className={`flex items-center gap-1.5 text-sm font-semibold ${item.tone === 'muted' ? 'text-ee-text' : TONE_TEXT[item.tone]}`}>
              {ICONS[item.kind]}
              <span className="min-w-0 break-words">{activityText(t, item)}</span>
            </p>
            {item.kind === 'scan' && item.tone !== 'success' && (
              <Chip tone={item.tone} className="mt-0.5" data-testid="supervisor-activity-gps">
                {confidenceLabel(t, item.gpsConfidence ?? null)}
              </Chip>
            )}
            <p className="text-xs text-ee-muted">
              {personName(people, item.guardId) ?? t('supUnknownPerson')}
              {showSite && sites.get(item.siteId) ? ` · ${sites.get(item.siteId)?.name}` : ''}
            </p>
          </div>
        </li>
      ))}
    </DividedList>
  );
}
