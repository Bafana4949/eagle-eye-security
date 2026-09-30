'use client';

import React from 'react';
import type { Site } from '@/types/models';
import { useTranslation } from '@/lib/i18n/context';
import { formatSpan, formatWhen, gateEventMs, personName, type VehiclePresence } from '../data/derive';
import type { GateRow, PersonInfo } from '../data/types';
import { EvidencePhoto } from './EvidencePhoto';
import { Chip, DividedList, EmptyLine, TimeCell } from './Primitives';

function vehicleText(row: GateRow): string {
  return [row.make_model, row.vehicle_colour, row.vehicle_description].filter(Boolean).join(' · ');
}

function visitText(row: GateRow): string {
  return [row.driver_name, row.company, row.visit_reason, row.person_visited].filter(Boolean).join(' · ');
}

/** Vehicles still inside: IN entries with no exit linked to them, longest on site first. */
export function VehiclesOnSiteList({
  presence,
  people,
  sites,
  showSite,
  now,
  testId
}: {
  presence: VehiclePresence;
  people: Readonly<Record<string, PersonInfo>>;
  sites: ReadonlyMap<string, Site>;
  showSite: boolean;
  now: number;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {presence.onSite.length === 0 ? (
        <EmptyLine testId={`${testId}-empty`}>{t('supNoVehiclesOnSite')}</EmptyLine>
      ) : (
        <DividedList testId={testId}>
          {presence.onSite.map(({ entry, enteredAt }) => {
            const site = sites.get(entry.site_id);
            const vehicle = vehicleText(entry);
            const visit = visitText(entry);
            return (
              <li key={entry.id} className="flex gap-3 px-3 py-3" data-testid={`${testId}-row`}>
                <TimeCell ms={enteredAt} now={now} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-display text-xl font-semibold tracking-wide text-ee-text">{entry.license_plate}</span>
                    <Chip tone={now - enteredAt > 12 * 3600000 ? 'warning' : 'muted'} data-testid={`${testId}-dwell`}>
                      {t('supOnSiteFor', formatSpan(now - enteredAt))}
                    </Chip>
                  </div>
                  {vehicle && <p className="break-words text-sm text-ee-text">{vehicle}</p>}
                  {visit && <p className="break-words text-sm text-ee-muted">{visit}</p>}
                  <p className="text-xs text-ee-muted">
                    {t('supLoggedBy', personName(people, entry.guard_id) ?? t('supUnknownPerson'))}
                    {showSite && site ? ` · ${site.name}` : ''}
                  </p>
                  {entry.vehicle_photo_url && (
                    <EvidencePhoto path={entry.vehicle_photo_url} label={t('supVehiclePhoto')} testId={`${testId}-photo`} />
                  )}
                </div>
              </li>
            );
          })}
        </DividedList>
      )}
      {presence.unlinkedExit.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm text-ee-warning">{t('supUnlinkedExitNote')}</p>
          <DividedList testId={`${testId}-unlinked`}>
            {presence.unlinkedExit.map(({ entry, enteredAt, exit }) => (
              <li key={entry.id} className="px-3 py-2 text-sm">
                <span className="font-semibold text-ee-text">{entry.license_plate}</span>
                <span className="text-ee-muted">
                  {' '}
                  {t('supInOut', formatWhen(enteredAt, now), formatWhen(gateEventMs(exit), now))}
                </span>
              </li>
            ))}
          </DividedList>
        </div>
      )}
    </div>
  );
}

/** Gate log, newest first. */
export function GateLogList({
  rows,
  people,
  sites,
  showSite,
  now,
  limit,
  testId
}: {
  rows: readonly GateRow[];
  people: Readonly<Record<string, PersonInfo>>;
  sites: ReadonlyMap<string, Site>;
  showSite: boolean;
  now: number;
  limit: number;
  testId: string;
}) {
  const { t } = useTranslation();
  const sorted = [...rows].sort((a, b) => (gateEventMs(b) ?? 0) - (gateEventMs(a) ?? 0)).slice(0, limit);
  if (sorted.length === 0) return <EmptyLine testId={`${testId}-empty`}>{t('supNoGateEntries')}</EmptyLine>;
  return (
    <DividedList testId={testId}>
      {sorted.map((row) => {
        const site = sites.get(row.site_id);
        const vehicle = vehicleText(row);
        const visit = visitText(row);
        return (
          <li key={row.id} className="flex gap-3 px-3 py-2.5" data-testid={`${testId}-row`}>
            <TimeCell ms={gateEventMs(row)} now={now} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={row.direction === 'in' ? 'success' : 'muted'}>
                  {row.direction === 'in' ? t('supIn') : t('supOut')}
                </Chip>
                <span className="font-display text-lg font-semibold tracking-wide text-ee-text">{row.license_plate}</span>
                {row.is_disc_scanned && <span className="text-xs text-ee-muted">{t('supDiscRead')}</span>}
              </div>
              {vehicle && <p className="break-words text-sm text-ee-text">{vehicle}</p>}
              {visit && <p className="break-words text-sm text-ee-muted">{visit}</p>}
              <p className="text-xs text-ee-muted">
                {personName(people, row.guard_id) ?? t('supUnknownPerson')}
                {showSite && site ? ` · ${site.name}` : ''}
                {row.direction === 'out' && row.dwell_duration_seconds !== null
                  ? ` · ${t('supWasOnSite', formatSpan(row.dwell_duration_seconds * 1000))}`
                  : ''}
                {row.direction === 'out' && !row.linked_entry_id ? ` · ${t('supExitNotLinked')}` : ''}
              </p>
              {row.vehicle_photo_url && (
                <EvidencePhoto path={row.vehicle_photo_url} label={t('supVehiclePhoto')} testId={`${testId}-photo`} />
              )}
            </div>
          </li>
        );
      })}
    </DividedList>
  );
}
