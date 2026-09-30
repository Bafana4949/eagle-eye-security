'use client';

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { formatDuration } from '@/features/shifts/shiftCalculator';
import { formatSastStamp, timeOnSiteMs, type GateRecord } from './gateLogic';
import type { OnSiteSource } from './gateData';
import { noticeClass } from './styles';

export interface OnSiteListStatus {
  loading: boolean;
  source: OnSiteSource | null;
  serverFailed: boolean;
  serverListAt: string | null;
}

interface VehiclesOnSiteListProps {
  vehicles: GateRecord[];
  now: number;
  status: OnSiteListStatus;
  onRefresh: () => void;
  /** When given, rows are buttons that pick the vehicle (OUT mode). */
  onPick?: (vehicle: GateRecord) => void;
  selectedId?: string | null;
}

/** Where the list comes from, said plainly (offline lists can be out of date). */
function ListSourceLine({ status, now, onRefresh }: { status: OnSiteListStatus; now: number; onRefresh: () => void }) {
  const { t } = useTranslation();
  let line: React.ReactNode = null;
  if (status.source === 'server' && status.serverListAt) {
    line = <span className="text-ee-muted">{t('gateOnSiteUpdated', formatSastStamp(status.serverListAt, now))}</span>;
  } else if (status.source === 'cache' && status.serverListAt) {
    line = <span className="text-ee-warning">{t('gateOnSiteOfflineCached', formatSastStamp(status.serverListAt, now))}</span>;
  } else if (status.source === 'device' || status.source === 'cache') {
    line = (
      <span className="text-ee-warning">
        {status.serverFailed ? t('gateOnSiteLoadFailed') : t('gateOnSiteOfflineNoCache')}
      </span>
    );
  } else if (status.serverFailed) {
    line = <span className="text-ee-warning">{t('gateOnSiteLoadFailed')}</span>;
  }
  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-sm">
      <p data-testid="gate-onsite-source" className="min-w-0 flex-1">
        {line}
      </p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={status.loading}
        aria-label={t('gateOnSiteRefresh')}
        data-testid="gate-onsite-refresh"
        className="grid min-h-12 min-w-12 shrink-0 place-items-center rounded-lg border border-ee-border text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text disabled:opacity-50"
      >
        <RefreshCw className={`h-5 w-5 ${status.loading ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
      </button>
    </div>
  );
}

function VehicleSummary({ vehicle, now }: { vehicle: GateRecord; now: number }) {
  const { t } = useTranslation();
  const details = [vehicle.makeModel, vehicle.vehicleColour].filter(Boolean).join(', ');
  const who = [vehicle.driverName, vehicle.company].filter(Boolean).join(' – ');
  return (
    <span className="block min-w-0">
      <span className="block font-display text-xl font-bold tracking-wide text-ee-text break-all">
        {vehicle.displayPlate}
      </span>
      {details && <span className="block text-sm text-ee-text">{details}</span>}
      <span className="block text-sm text-ee-muted">
        {t('gateOnSiteInSince', formatSastStamp(vehicle.entryTime, now))}
        {' · '}
        {t('gateOnSiteDuration', formatDuration(timeOnSiteMs(vehicle.entryTime, now)))}
      </span>
      {who && <span className="block text-sm text-ee-muted">{who}</span>}
      {vehicle.source === 'device' && vehicle.syncState === 'failed' && (
        <span className="mt-1 block text-xs font-semibold text-ee-danger">{t('gateOnSiteRejected')}</span>
      )}
      {vehicle.source === 'device' && vehicle.syncState !== 'failed' && vehicle.syncState !== 'synced' && (
        <span className="mt-1 block text-xs font-semibold text-ee-warning">{t('gateOnSiteDeviceOnly')}</span>
      )}
    </span>
  );
}

export function VehiclesOnSiteList({ vehicles, now, status, onRefresh, onPick, selectedId }: VehiclesOnSiteListProps) {
  const { t } = useTranslation();

  return (
    <div>
      {status.loading && vehicles.length === 0 ? (
        <p role="status" className="py-3 text-sm text-ee-muted">
          {t('gateOnSiteLoading')}
        </p>
      ) : vehicles.length === 0 ? (
        <p data-testid="gate-onsite-empty" className={noticeClass.info}>
          {t('gateOnSiteEmpty')}
        </p>
      ) : (
        <ul data-testid="gate-onsite-list" className="divide-y divide-ee-border rounded-lg border border-ee-border bg-ee-surface">
          {vehicles.map((vehicle) => {
            const selected = selectedId === vehicle.id;
            return (
              <li key={vehicle.id}>
                {onPick ? (
                  <button
                    type="button"
                    onClick={() => onPick(vehicle)}
                    aria-pressed={selected}
                    data-testid="gate-onsite-item"
                    data-plate={vehicle.plate}
                    className={`flex min-h-16 w-full items-start gap-3 px-3 py-3 text-left hover:bg-ee-surface-raised ${
                      selected ? 'bg-ee-primary/15 outline outline-2 -outline-offset-2 outline-ee-primary' : ''
                    }`}
                  >
                    <VehicleSummary vehicle={vehicle} now={now} />
                  </button>
                ) : (
                  <div data-testid="gate-onsite-item" data-plate={vehicle.plate} className="px-3 py-3">
                    <VehicleSummary vehicle={vehicle} now={now} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ListSourceLine status={status} now={now} onRefresh={onRefresh} />
    </div>
  );
}
