'use client';

import { useEffect, useRef, useState } from 'react';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';

/**
 * connecting: channel being set up; live: SUBSCRIBED; reconnecting: CHANNEL_ERROR, TIMED_OUT
 * or CLOSED (realtime-js retries by itself, and the channel is rebuilt if it stays down);
 * off: realtime could not be started at all (e.g. the app is not configured).
 */
export type RealtimeState = 'connecting' | 'live' | 'reconnecting' | 'off';

export type RealtimeTable = 'panic_alerts' | 'incidents' | 'patrol_scans' | 'gate_entries' | 'shifts';

export interface RealtimeChange {
  table: RealtimeTable;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  row: Record<string, unknown>;
}

/** A channel that is not SUBSCRIBED for this long is torn down and rebuilt. */
const REBUILD_AFTER_MS = 45_000;
/** Supabase realtime accepts at most 100 values in an `in` filter. */
const MAX_FILTER_IDS = 100;

let channelCounter = 0;

/**
 * ONE Supabase realtime channel for the page, with a postgres_changes subscription per table,
 * filtered to the given sites (RLS applies to realtime too). Reports the subscribe status so the
 * page can show "Live" vs "Reconnecting". The caller must ALSO poll: realtime can silently miss
 * events (sleeping laptop, proxy dropping websockets). The channel is removed on unmount.
 */
export function useRealtimeChannel(options: {
  enabled: boolean;
  name: string;
  siteIds: readonly string[];
  tables: readonly RealtimeTable[];
  onChange: (change: RealtimeChange) => void;
}): RealtimeState {
  const { enabled, name, siteIds, tables } = options;
  const onChangeRef = useRef(options.onChange);
  useEffect(() => {
    onChangeRef.current = options.onChange;
  });

  const [attempt, setAttempt] = useState(0);
  const siteKey = [...siteIds].sort().join(',');
  const tableKey = tables.join(',');
  const signature = `${enabled}|${name}|${siteKey}|${tableKey}|${attempt}`;
  const [status, setStatus] = useState<{ signature: string; state: RealtimeState }>({ signature: '', state: 'connecting' });

  useEffect(() => {
    if (!enabled || siteKey === '') return;
    let disposed = false;
    let rebuildTimer: number | null = null;
    let client: ReturnType<typeof createClient>;
    try {
      client = createClient();
    } catch {
      queueMicrotask(() => {
        if (!disposed) setStatus({ signature, state: 'off' });
      });
      return () => {
        disposed = true;
      };
    }

    const ids = siteKey.split(',');
    const filter = ids.length === 1 ? `site_id=eq.${ids[0]}` : ids.length <= MAX_FILTER_IDS ? `site_id=in.(${ids.join(',')})` : undefined;
    channelCounter += 1;
    let channel: RealtimeChannel = client.channel(`${name}-${channelCounter}`);
    for (const table of tableKey.split(',') as RealtimeTable[]) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          if (disposed) return;
          const row = (payload.eventType === 'DELETE' ? payload.old : payload.new) as Record<string, unknown>;
          onChangeRef.current({ table, eventType: payload.eventType, row: row ?? {} });
        }
      );
    }

    const scheduleRebuild = () => {
      if (rebuildTimer !== null) return;
      rebuildTimer = window.setTimeout(() => {
        rebuildTimer = null;
        if (!disposed) setAttempt((n) => n + 1);
      }, REBUILD_AFTER_MS);
    };
    const cancelRebuild = () => {
      if (rebuildTimer !== null) window.clearTimeout(rebuildTimer);
      rebuildTimer = null;
    };

    // Not subscribed in time → rebuild (covers a subscribe that never answers).
    scheduleRebuild();
    channel.subscribe((subscribeStatus) => {
      if (disposed) return;
      if (subscribeStatus === 'SUBSCRIBED') {
        cancelRebuild();
        setStatus({ signature, state: 'live' });
        return;
      }
      // CHANNEL_ERROR / TIMED_OUT / CLOSED
      setStatus({ signature, state: 'reconnecting' });
      scheduleRebuild();
    });

    return () => {
      disposed = true;
      cancelRebuild();
      void client.removeChannel(channel);
    };
  }, [enabled, name, siteKey, tableKey, signature]);

  if (!enabled || siteKey === '') return 'off';
  return status.signature === signature ? status.state : 'connecting';
}
