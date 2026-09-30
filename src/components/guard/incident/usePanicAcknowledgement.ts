'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { isAcknowledged, type PanicAcknowledgement } from './incidentLogic';

/** How often the guard's phone asks the server whether the SOS was acknowledged. */
export const ACK_POLL_MS = 10_000;

interface PanicRow {
  status: PanicAcknowledgement['status'];
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

interface SitePerson {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
}

export interface PanicAcknowledgementState {
  acknowledgement: PanicAcknowledgement | null;
  /** Last error of the check itself (the alert is unaffected). */
  checkError: string | null;
}

const EMPTY: PanicAcknowledgementState = { acknowledgement: null, checkError: null };

/**
 * Polls panic_alerts (by offline_uuid = the queued event id) every 10 s while `enabled`
 * (panic screen open, alert confirmed on the server). Skips a poll while the phone is offline and
 * stops as soon as `enabled` turns false, the component unmounts or the alert is resolved. Acknowledgement is reported
 * only from the database row (status / acknowledged_at); the acknowledger's name is looked up
 * through the site_people RPC and left out when it is not visible to the guard.
 */
export function usePanicAcknowledgement(
  eventId: string | null,
  siteId: string | null,
  enabled: boolean
): PanicAcknowledgementState {
  const [state, setState] = useState<PanicAcknowledgementState>(EMPTY);
  const [trackedId, setTrackedId] = useState<string | null>(eventId);

  if (trackedId !== eventId) {
    setTrackedId(eventId);
    setState(EMPTY);
  }

  useEffect(() => {
    if (!enabled || !eventId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const names = new Map<string, string | null>();

    const lookupName = async (userId: string): Promise<string | null> => {
      if (names.has(userId)) return names.get(userId) ?? null;
      let name: string | null = null;
      if (siteId) {
        try {
          const { data, error } = await createClient().rpc('site_people', { p_site_id: siteId });
          if (!error && Array.isArray(data)) {
            const person = (data as SitePerson[]).find((row) => row.user_id === userId);
            const full = person ? `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() : '';
            name = full || null;
          }
        } catch {
          name = null;
        }
      }
      names.set(userId, name);
      return name;
    };

    const poll = async () => {
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (online) {
        try {
          const { data, error } = await createClient()
            .from('panic_alerts')
            .select('status, acknowledged_at, acknowledged_by')
            .eq('offline_uuid', eventId)
            .maybeSingle();
          if (cancelled) return;
          if (error) {
            setState((prev) => ({ ...prev, checkError: error.message }));
          } else {
            const row = data as PanicRow | null;
            if (row && isAcknowledged({ status: row.status, acknowledgedAt: row.acknowledged_at })) {
              const name = row.acknowledged_by ? await lookupName(row.acknowledged_by) : null;
              if (cancelled) return;
              setState({
                acknowledgement: {
                  status: row.status,
                  acknowledgedAt: row.acknowledged_at,
                  acknowledgedBy: row.acknowledged_by,
                  acknowledgedByName: name
                },
                checkError: null
              });
              // Resolved is final: nothing more to wait for.
              if (row.status === 'resolved') return;
            } else {
              setState((prev) => ({ ...prev, checkError: null }));
            }
          }
        } catch (error) {
          if (cancelled) return;
          setState((prev) => ({ ...prev, checkError: error instanceof Error ? error.message : String(error) }));
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), ACK_POLL_MS);
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, eventId, siteId]);

  return eventId ? state : EMPTY;
}
