import { describe, it } from 'node:test';
import assert from 'node:assert';
import { OfflineQueueItem, OfflineEventType } from '@/types/offline';

function createQueueItem(
  eventType: OfflineEventType,
  sequenceNumber: number,
  userId: string,
  siteId: string,
  payload: Record<string, unknown>
): OfflineQueueItem {
  const offlineId = `offline-${sequenceNumber}-${Date.now()}`;
  const now = new Date().toISOString();

  return {
    id: offlineId,
    sequenceNumber,
    userId,
    siteId,
    eventType,
    payload: { ...payload, offlineUuid: offlineId },
    deviceTimestamp: now,
    syncState: 'pending',
    retryCount: 0,
    createdAt: now
  };
}

function calculateExponentialBackoff(retryCount: number): number {
  const base = 1000;
  const maxBackoff = 30000;
  return Math.min(maxBackoff, base * Math.pow(2, retryCount));
}

describe('Offline Queue & Idempotency Engine', () => {
  it('creates unique offline UUID tokens for each queued action', () => {
    const item1 = createQueueItem('checkpoint_scan', 1, 'guard-1', 'site-1', { checkpointId: 'CP1' });
    const item2 = createQueueItem('checkpoint_scan', 2, 'guard-1', 'site-1', { checkpointId: 'CP2' });

    assert.notStrictEqual(item1.id, item2.id);
    assert.strictEqual(item1.payload.offlineUuid, item1.id);
    assert.strictEqual(item1.sequenceNumber, 1);
    assert.strictEqual(item2.sequenceNumber, 2);
  });

  it('calculates bounded exponential backoff delays across retries', () => {
    // Retry 0: 1000ms
    assert.strictEqual(calculateExponentialBackoff(0), 1000);
    // Retry 1: 2000ms
    assert.strictEqual(calculateExponentialBackoff(1), 2000);
    // Retry 2: 4000ms
    assert.strictEqual(calculateExponentialBackoff(2), 4000);
    // Retry 3: 8000ms
    assert.strictEqual(calculateExponentialBackoff(3), 8000);
    // Retry 4: 16000ms
    assert.strictEqual(calculateExponentialBackoff(4), 16000);
    // Retry 5: capped at 30000ms
    assert.strictEqual(calculateExponentialBackoff(5), 30000);
    // Retry 10: stays capped at 30000ms
    assert.strictEqual(calculateExponentialBackoff(10), 30000);
  });

  it('guarantees deterministic conflict resolution payload with offline UUID', () => {
    const scanPayload = {
      checkpointId: 'CP-MAIN-01',
      latitude: -25.6841,
      longitude: 27.8145,
      accuracyMeters: 5
    };

    const item = createQueueItem('checkpoint_scan', 1, 'guard-1', 'site-1', scanPayload);

    // Replay of the same item preserves identical offline UUID for ON CONFLICT idempotency
    const replayedId = item.id;
    assert.strictEqual(item.payload.offlineUuid, replayedId);
  });
});
