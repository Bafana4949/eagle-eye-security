import { offlineDB, StoredMediaBlob } from './db';
import { OfflineQueueItem, OfflineEventType, OfflineSyncSummary } from '@/types/offline';
import { createClient } from '@/lib/supabase/client';

export class OfflineSyncEngine {
  private isSyncing = false;
  private listeners: ((summary: OfflineSyncSummary) => void)[] = [];

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.handleOnline());
      window.addEventListener('offline', () => void this.notifyListeners());
    }
  }

  public subscribe(callback: (summary: OfflineSyncSummary) => void): () => void {
    this.listeners.push(callback);
    void this.getSummary().then(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  private async notifyListeners(): Promise<void> {
    const summary = await this.getSummary();
    this.listeners.forEach((l) => l(summary));
  }

  public async getSummary(): Promise<OfflineSyncSummary> {
    if (!offlineDB) {
      return { isOnline: true, pendingCount: 0, syncingCount: 0, failedCount: 0 };
    }

    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    const pendingCount = await offlineDB.syncQueue.where('syncState').equals('pending').count();
    const syncingCount = await offlineDB.syncQueue.where('syncState').equals('syncing').count();
    const failedCount = await offlineDB.syncQueue.where('syncState').equals('failed').count();

    const lastSyncedItem = await offlineDB.syncQueue
      .where('syncState')
      .equals('synced')
      .reverse()
      .sortBy('syncedAt');

    return {
      isOnline,
      pendingCount,
      syncingCount,
      failedCount,
      lastSyncTimestamp: lastSyncedItem[0]?.syncedAt
    };
  }

  private handleOnline(): void {
    void this.notifyListeners();
    void this.triggerSync();
  }

  /**
   * Calculates exponential backoff with jitter (in ms)
   */
  private calculateBackoffMs(retryCount: number): number {
    const base = 1000;
    const maxBackoff = 30000;
    const exponential = Math.min(maxBackoff, base * Math.pow(2, retryCount));
    const jitter = Math.random() * 500;
    return exponential + jitter;
  }

  /**
   * Enqueues an offline action into IndexedDB.
   * Immediately persists to local cache for instant UI feedback, then schedules network sync.
   */
  public async enqueue(
    eventType: OfflineEventType,
    userId: string,
    siteId: string,
    payload: Record<string, unknown>,
    mediaFiles?: { field: string; blob: Blob; fileName: string; mimeType: string }[]
  ): Promise<string> {
    if (!offlineDB) throw new Error('Offline database not initialized');

    const offlineId = crypto.randomUUID();
    const now = new Date().toISOString();
    const count = await offlineDB.syncQueue.count();

    const queueItem: OfflineQueueItem = {
      id: offlineId,
      sequenceNumber: count + 1,
      userId,
      siteId,
      eventType,
      payload: { ...payload, offlineUuid: offlineId },
      deviceTimestamp: now,
      syncState: 'pending',
      retryCount: 0,
      createdAt: now
    };

    await offlineDB.syncQueue.add(queueItem);

    // Save attached media blobs to local IndexedDB store
    if (mediaFiles && mediaFiles.length > 0) {
      for (const media of mediaFiles) {
        const storedBlob: StoredMediaBlob = {
          id: `${offlineId}-${media.field}`,
          queueItemId: offlineId,
          field: media.field,
          data: media.blob,
          mimeType: media.mimeType,
          fileName: media.fileName,
          createdAt: now
        };
        await offlineDB.mediaBlobs.add(storedBlob);
      }
    }

    void this.notifyListeners();

    // Trigger sync in background if currently online
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      void this.triggerSync();
    }

    return offlineId;
  }

  /**
   * Processes the sync queue sequentially and idempotently against Supabase.
   */
  public async triggerSync(): Promise<void> {
    if (this.isSyncing || !offlineDB) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    this.isSyncing = true;
    void this.notifyListeners();

    try {
      const items = await offlineDB.syncQueue
        .where('syncState')
        .anyOf(['pending', 'failed'])
        .sortBy('sequenceNumber');

      const supabase = createClient();

      for (const item of items) {
        if (item.retryCount >= 5) continue; // Skip persistent failures until manual retry

        await offlineDB.syncQueue.update(item.id, { syncState: 'syncing' });
        void this.notifyListeners();

        try {
          // 1. Upload any pending photos to Supabase Storage
          const mediaList = await offlineDB.mediaBlobs.where('queueItemId').equals(item.id).toArray();
          const uploadedUrls: Record<string, string> = {};

          for (const media of mediaList) {
            const filePath = `${item.siteId}/${item.eventType}/${item.id}-${media.field}.jpg`;
            const { error: uploadError } = await supabase.storage
              .from('evidence-media')
              .upload(filePath, media.data, {
                contentType: media.mimeType,
                upsert: true
              });

            if (!uploadError) {
              const { data: publicData } = supabase.storage.from('evidence-media').getPublicUrl(filePath);
              uploadedUrls[media.field] = publicData.publicUrl;
            }
          }

          // 2. Insert record into appropriate database table with idempotency guarantee
          await this.syncRecordToDatabase(supabase, item, uploadedUrls);

          // 3. Mark successful in queue
          await offlineDB.syncQueue.update(item.id, {
            syncState: 'synced',
            syncedAt: new Date().toISOString()
          });

          // Clean up local media blobs once securely uploaded
          await offlineDB.mediaBlobs.where('queueItemId').equals(item.id).delete();
        } catch (err: unknown) {
          const rawMessage = err instanceof Error ? err.message : String(err);
          // Format friendly error for security guard view
          const friendlyMessage = rawMessage.includes('PGRST') 
            ? 'Connection interrupted. Saved locally and retrying automatically.'
            : rawMessage;

          const backoffDelay = this.calculateBackoffMs(item.retryCount);

          await offlineDB.syncQueue.update(item.id, {
            syncState: 'failed',
            retryCount: item.retryCount + 1,
            lastError: friendlyMessage
          });

          // Wait before attempting next queued item on failure
          await new Promise((r) => setTimeout(r, backoffDelay));
        }
      }
    } finally {
      this.isSyncing = false;
      void this.notifyListeners();
    }
  }

  private async syncRecordToDatabase(
    supabase: ReturnType<typeof createClient>,
    item: OfflineQueueItem,
    uploadedUrls: Record<string, string>
  ): Promise<void> {
    const payload = item.payload;

    switch (item.eventType) {
      case 'checkpoint_scan': {
        const { error } = await supabase.from('patrol_scans').upsert(
          {
            offline_uuid: item.id,
            shift_id: payload.shiftId,
            patrol_round_id: payload.patrolRoundId || null,
            checkpoint_id: payload.checkpointId,
            guard_id: item.userId,
            scan_timestamp_device: item.deviceTimestamp,
            latitude: payload.latitude || null,
            longitude: payload.longitude || null,
            accuracy_meters: payload.accuracyMeters || null,
            distance_to_checkpoint_meters: payload.distanceToCheckpointMeters || null,
            is_valid_proximity: payload.isValidProximity ?? true,
            method: payload.method || 'qr',
            hash_chain: payload.hashChain || null,
            prev_hash_chain: payload.prevHashChain || null
          },
          { onConflict: 'offline_uuid' }
        );
        if (error) throw error;
        break;
      }

      case 'incident': {
        const { data: inc, error: incError } = await supabase
          .from('incidents')
          .upsert(
            {
              offline_uuid: item.id,
              site_id: item.siteId,
              shift_id: payload.shiftId || null,
              guard_id: item.userId,
              incident_type: payload.incidentType,
              severity: payload.severity || 'medium',
              description: payload.description || '',
              latitude: payload.latitude || null,
              longitude: payload.longitude || null,
              status: 'reported',
              reported_at: item.deviceTimestamp
            },
            { onConflict: 'offline_uuid' }
          )
          .select('id')
          .single();

        if (incError) throw incError;

        if (inc && uploadedUrls.photo) {
          await supabase.from('incident_media').insert({
            incident_id: inc.id,
            media_url: uploadedUrls.photo,
            media_type: 'image/jpeg'
          });
        }
        break;
      }

      case 'gate_entry': {
        const { error } = await supabase.from('gate_entries').upsert(
          {
            offline_uuid: item.id,
            site_id: item.siteId,
            shift_id: payload.shiftId || null,
            guard_id: item.userId,
            direction: payload.direction || 'in',
            license_plate: payload.licensePlate,
            make_model: payload.makeModel || null,
            vehicle_colour: payload.vehicleColour || null,
            disc_expiry_date: payload.discExpiryDate || null,
            vin_number: payload.vinNumber || null,
            driver_name: payload.driverName || null,
            driver_phone: payload.driverPhone || null,
            company: payload.company || null,
            visit_reason: payload.visitReason || null,
            is_disc_scanned: payload.isDiscScanned ?? false,
            entry_time: payload.entryTime || item.deviceTimestamp,
            exit_time: payload.exitTime || null,
            dwell_duration_seconds: payload.dwellDurationSeconds || null,
            vehicle_photo_url: uploadedUrls.photo || null
          },
          { onConflict: 'offline_uuid' }
        );
        if (error) throw error;
        break;
      }

      case 'panic': {
        const { error } = await supabase.from('panic_alerts').upsert(
          {
            offline_uuid: item.id,
            site_id: item.siteId,
            shift_id: payload.shiftId || null,
            guard_id: item.userId,
            latitude: payload.latitude || null,
            longitude: payload.longitude || null,
            accuracy_meters: payload.accuracyMeters || null,
            status: 'active',
            triggered_at: item.deviceTimestamp
          },
          { onConflict: 'offline_uuid' }
        );
        if (error) throw error;
        break;
      }

      case 'shift_start': {
        const { error } = await supabase.from('shifts').upsert(
          {
            id: payload.shiftId || item.id,
            site_id: item.siteId,
            guard_id: item.userId,
            shift_type: payload.shiftType || 'night',
            scheduled_start: payload.scheduledStart,
            scheduled_end: payload.scheduledEnd,
            actual_start: item.deviceTimestamp,
            start_selfie_url: uploadedUrls.selfie || null,
            start_latitude: payload.latitude || null,
            start_longitude: payload.longitude || null,
            status: 'active'
          },
          { onConflict: 'id' }
        );
        if (error) throw error;
        break;
      }

      case 'shift_end': {
        const { error } = await supabase
          .from('shifts')
          .update({
            actual_end: item.deviceTimestamp,
            end_selfie_url: uploadedUrls.selfie || null,
            end_latitude: payload.latitude || null,
            end_longitude: payload.longitude || null,
            status: 'completed'
          })
          .eq('id', payload.shiftId);
        if (error) throw error;
        break;
      }
    }
  }
}

export const syncEngine = typeof window !== 'undefined' ? new OfflineSyncEngine() : (null as unknown as OfflineSyncEngine);
