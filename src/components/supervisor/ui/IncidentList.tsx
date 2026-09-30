'use client';

import React from 'react';
import { CheckCheck, MapPin, NotebookPen, Search, ShieldCheck } from 'lucide-react';
import type { IncidentStatus, Site } from '@/types/models';
import { useTranslation } from '@/lib/i18n/context';
import { formatWhen, personName, toMs } from '../data/derive';
import type { IncidentMediaRow, IncidentRow, PersonInfo } from '../data/types';
import { EvidencePhoto } from './EvidencePhoto';
import {
  incidentStatusLabel,
  incidentStatusTone,
  incidentTypeLabel,
  mapsUrl,
  severityLabel,
  severityTone,
  TONE_TEXT
} from './labels';
import { Chip, DividedList, EmptyLine, TimeCell } from './Primitives';

export type IncidentAction = 'acknowledge' | 'investigating' | 'resolve' | 'note';

export interface IncidentActionState {
  busy?: boolean;
  message?: { tone: 'success' | 'danger'; text: string };
}

export interface IncidentActions {
  onAction: (incident: IncidentRow, action: IncidentAction) => void;
  /** Writes need a connection: buttons are disabled offline, with this reason shown. */
  disabledReason: string | null;
  state: Readonly<Record<string, IncidentActionState>>;
}

function allowedActions(status: IncidentStatus): IncidentAction[] {
  switch (status) {
    case 'reported':
      return ['acknowledge', 'investigating', 'resolve', 'note'];
    case 'acknowledged':
      return ['investigating', 'resolve', 'note'];
    case 'investigating':
      return ['resolve', 'note'];
    default:
      return ['note'];
  }
}

/**
 * Incidents with their photos. Read-only unless `actions` is given (supervisor): the buttons
 * change only status and notes; the database records who acknowledged it and when.
 */
export function IncidentList({
  incidents,
  media,
  people,
  sites,
  showSite,
  showLocation,
  now,
  actions,
  testId
}: {
  incidents: readonly IncidentRow[];
  media: readonly IncidentMediaRow[];
  people: Readonly<Record<string, PersonInfo>>;
  sites: ReadonlyMap<string, Site>;
  showSite: boolean;
  showLocation: boolean;
  now: number;
  actions?: IncidentActions;
  testId: string;
}) {
  const { t } = useTranslation();
  if (incidents.length === 0) return <EmptyLine testId={`${testId}-empty`}>{t('supNoIncidents')}</EmptyLine>;

  const actionLabel: Record<IncidentAction, string> = {
    acknowledge: t('supAcknowledge'),
    investigating: t('supMarkInvestigating'),
    resolve: t('supResolve'),
    note: t('supEditNote')
  };
  const actionIcon: Record<IncidentAction, React.ReactNode> = {
    acknowledge: <CheckCheck className="h-4 w-4" aria-hidden="true" />,
    investigating: <Search className="h-4 w-4" aria-hidden="true" />,
    resolve: <ShieldCheck className="h-4 w-4" aria-hidden="true" />,
    note: <NotebookPen className="h-4 w-4" aria-hidden="true" />
  };

  return (
    <DividedList testId={testId}>
      {incidents.map((incident) => {
        const photos = media.filter((m) => m.incident_id === incident.id);
        const site = sites.get(incident.site_id);
        const ackBy = personName(people, incident.acknowledged_by);
        const state = actions?.state[incident.id];
        return (
          <li key={incident.id} className="flex gap-3 px-3 py-3" data-testid={`${testId}-row`} data-status={incident.status}>
            <TimeCell ms={toMs(incident.reported_at)} now={now} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words font-semibold text-ee-text">
                  {incidentTypeLabel(t, incident.incident_type)}
                </span>
                <Chip tone={incidentStatusTone(incident.status)} data-testid={`${testId}-status`}>
                  {incidentStatusLabel(t, incident.status)}
                </Chip>
              </div>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ee-muted">
                <Chip tone={severityTone(incident.severity)}>{severityLabel(t, incident.severity)}</Chip>
                <span>{personName(people, incident.guard_id) ?? t('supUnknownPerson')}</span>
                {showSite && site && <span>· {site.name}</span>}
              </p>
              {incident.description ? (
                <p className="whitespace-pre-wrap break-words text-sm text-ee-text">{incident.description}</p>
              ) : (
                <p className="text-sm text-ee-muted">{t('supNoDescription')}</p>
              )}
              {showLocation && incident.latitude !== null && incident.longitude !== null && (
                <a
                  href={mapsUrl(incident.latitude, incident.longitude)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-1 text-sm underline"
                >
                  <MapPin className="h-4 w-4" aria-hidden="true" />
                  {incident.accuracy_meters !== null
                    ? t('supMapWithAccuracy', Math.round(incident.accuracy_meters))
                    : t('supMap')}
                </a>
              )}
              {incident.acknowledged_at && (
                <p className="text-xs text-ee-muted" data-testid={`${testId}-ack`}>
                  {t('supAckBy', ackBy ?? t('supUnknownPerson'), formatWhen(toMs(incident.acknowledged_at), now))}
                </p>
              )}
              {incident.supervisor_notes && (
                <div className="rounded-lg border border-ee-border bg-ee-bg px-3 py-2 text-sm">
                  <span className="block text-xs text-ee-muted">{t('supSupervisorNotes')}</span>
                  <span className="whitespace-pre-wrap break-words text-ee-text">{incident.supervisor_notes}</span>
                </div>
              )}
              {photos.length > 0 && (
                <div className="flex flex-col gap-2">
                  {photos.map((photo, index) => (
                    <EvidencePhoto
                      key={photo.id}
                      path={photo.media_url}
                      label={t('supPhotoN', index + 1)}
                      testId={`${testId}-photo`}
                    />
                  ))}
                </div>
              )}
              {actions && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex flex-wrap gap-2">
                    {allowedActions(incident.status).map((action) => (
                      <button
                        key={action}
                        type="button"
                        onClick={() => actions.onAction(incident, action)}
                        disabled={Boolean(actions.disabledReason) || state?.busy}
                        className={
                          action === 'acknowledge'
                            ? 'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-ee-primary bg-ee-primary px-3 text-sm font-bold text-ee-on-primary hover:bg-ee-primary-strong disabled:opacity-50'
                            : 'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-ee-border bg-ee-bg px-3 text-sm font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-50'
                        }
                        data-testid={`${testId}-${action}`}
                      >
                        {actionIcon[action]}
                        {action === 'note' && !incident.supervisor_notes ? t('supAddNote') : actionLabel[action]}
                      </button>
                    ))}
                  </div>
                  <div aria-live="polite">
                    {state?.busy && <p className="text-xs text-ee-muted">{t('supSaving')}</p>}
                    {state?.message && (
                      <p className={`text-xs font-semibold ${TONE_TEXT[state.message.tone]}`} data-testid={`${testId}-result`}>
                        {state.message.text}
                      </p>
                    )}
                    {actions.disabledReason && <p className="text-xs text-ee-warning">{actions.disabledReason}</p>}
                  </div>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </DividedList>
  );
}
