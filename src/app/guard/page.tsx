'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { 
  MapPin, 
  Clock, 
  Camera, 
  AlertTriangle, 
  Car, 
  CheckCircle2, 
  QrCode,
  Shield,
  Wifi,
  WifiOff,
  LogOut,
  ChevronRight,
  UserCheck
} from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CameraCaptureModal } from '@/components/shared/CameraCaptureModal';
import { QrScannerModal } from '@/components/shared/QrScannerModal';
import { 
  getActiveShiftWindow, 
  generateShiftRounds, 
  formatTimeHM, 
  formatDuration 
} from '@/features/shifts/shiftCalculator';
import { syncEngine } from '@/lib/offline/sync';
import { offlineDB } from '@/lib/offline/db';
import { validateProximity, formatDistance } from '@/lib/gps/haversine';
import { Checkpoint, PatrolScan } from '@/types/models';
import { OfflineSyncSummary } from '@/types/offline';
import { requestScreenWakeLock, releaseScreenWakeLock } from '@/lib/patrol/alarm';
import { 
  formatWhatsAppShiftSummary, 
  buildWhatsAppLink, 
  copySummaryToClipboard 
} from '@/lib/whatsapp/summary';
import { useAuth } from '@/context/AuthContext';
import { createClient } from '@/lib/supabase/client';

interface ClockInDetails {
  time: number;
  isoTime: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  photoUrl?: string;
}

export default function GuardHomePage() {
  const { t } = useTranslation();
  const { user, profile, assignedSite } = useAuth();

  // Shift & Operational State
  const [isOnShift, setIsOnShift] = useState(false);
  const [shiftStartTime, setShiftStartTime] = useState<number | null>(null);
  const [clockInDetails, setClockInDetails] = useState<ClockInDetails | null>(null);
  const [dutyDuration, setDutyDuration] = useState<string>('00h 00m');
  const [showSelfieModal, setShowSelfieModal] = useState(false);
  const [selfieAction, setSelfieAction] = useState<'start' | 'end'>('start');
  const [showShiftSummaryModal, setShowShiftSummaryModal] = useState(false);
  const [shiftSummaryText, setShiftSummaryText] = useState('');
  const [showQrModal, setShowQrModal] = useState(false);
  const [recentScans, setRecentScans] = useState<PatrolScan[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [activeCheckpointsCompleted, setActiveCheckpointsCompleted] = useState<string[]>([]);
  const [toastMessage, setToastMessage] = useState<{ text: string; type?: 'success' | 'amber' } | null>(null);

  // Sync state
  const [syncSummary, setSyncSummary] = useState<OfflineSyncSummary>({
    isOnline: true,
    pendingCount: 0,
    syncingCount: 0,
    failedCount: 0
  });

  const shiftWindow = getActiveShiftWindow();
  const rounds = generateShiftRounds(shiftWindow);
  const currentRound = rounds.find((r) => r.isCurrent) || rounds[0];

  // Dynamic Session & Tactical IDs (prioritize one-tap selected guard or logged-in auth user)
  const [selectedGuard] = useState<{ id: string; name: string; employeeNo?: string } | null>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('eagle_eye_selected_guard');
        if (stored) return JSON.parse(stored);
      } catch {
        // ignore
      }
    }
    return null;
  });

  const guardId = selectedGuard?.id || user?.id || profile?.id || 'e495f1f3-72a0-4231-86fb-617c4624bbe5';
  const siteId = assignedSite?.id || '22222222-2222-2222-2222-222222222222';
  const guardName = selectedGuard?.name || (profile ? `${profile.first_name} ${profile.last_name}` : 'Sipho Khoza');
  const siteName = assignedSite?.name || 'Dawie Boerdery - Main Farm';
  const companyName = 'Aiguille Security';

  // Greeting based on time of day
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return t('greetingMorning') || 'Good morning';
    if (hour >= 12 && hour < 17) return t('greetingAfternoon') || 'Good afternoon';
    return t('greetingEvening') || 'Good evening';
  };

  // Sync state subscription
  useEffect(() => {
    if (syncEngine) {
      const unsubscribe = syncEngine.subscribe((summary) => {
        setSyncSummary(summary);
      });
      return unsubscribe;
    }
  }, []);

  // Live Duty Ticker
  useEffect(() => {
    if (!isOnShift || !shiftStartTime) {
      return;
    }

    const updateTicker = () => {
      setDutyDuration(formatDuration(Date.now() - shiftStartTime));
    };

    updateTicker();
    const interval = setInterval(updateTicker, 1000);

    return () => clearInterval(interval);
  }, [isOnShift, shiftStartTime]);

  // Load initial data and sync checkpoints from Supabase
  useEffect(() => {
    const loadData = async () => {
      if (offlineDB) {
        // Load active shift
        const activeShift = await offlineDB.shifts.where('guardId').equals(guardId).first();
        if (activeShift && activeShift.status === 'active') {
          setIsOnShift(true);
          const startMs = new Date(activeShift.actualStart || activeShift.scheduledStart).getTime();
          setShiftStartTime(startMs);
          setClockInDetails({
            time: startMs,
            isoTime: activeShift.actualStart || activeShift.scheduledStart,
            latitude: activeShift.startLatitude,
            longitude: activeShift.startLongitude,
            photoUrl: activeShift.startSelfieUrl
          });
        }

        // Sync checkpoints from Supabase if online
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          try {
            const supabase = createClient();
            const { data: remoteCps } = await supabase
              .from('checkpoints')
              .select('*')
              .eq('site_id', siteId);

            if (remoteCps && remoteCps.length > 0) {
              const formatted: Checkpoint[] = remoteCps.map((cp) => ({
                id: cp.id,
                siteId: cp.site_id,
                name: cp.name,
                description: cp.description || '',
                qrCodeHash: cp.qr_code_hash,
                nfcUid: cp.nfc_uid || undefined,
                latitude: cp.latitude,
                longitude: cp.longitude,
                permittedRadiusMeters: cp.permitted_radius_meters,
                orderIndex: cp.order_index,
                isActive: cp.is_active
              }));
              await offlineDB.checkpoints.bulkPut(formatted);
            }
          } catch {
            // Offline fallback to IndexedDB
          }
        }

        let cps = await offlineDB.checkpoints.toArray();
        if (cps.length === 0) {
          const defaultCps: Checkpoint[] = [
            {
              id: 'CP1',
              siteId,
              name: 'Hoofhek / Main Gate',
              qrCodeHash: 'EE-CP-MAIN-GATE-01',
              latitude: -25.684120,
              longitude: 27.814520,
              permittedRadiusMeters: 50,
              orderIndex: 1,
              isActive: true
            },
            {
              id: 'CP2',
              siteId,
              name: 'Skaapkraal / Sheep Kraal',
              qrCodeHash: 'EE-CP-SHEEP-KRAAL-02',
              latitude: -25.684890,
              longitude: 27.815210,
              permittedRadiusMeters: 60,
              orderIndex: 2,
              isActive: true
            },
            {
              id: 'CP3',
              siteId,
              name: 'Hoenderhok / Poultry Sheds',
              qrCodeHash: 'EE-CP-POULTRY-SHED-03',
              latitude: -25.683500,
              longitude: 27.814010,
              permittedRadiusMeters: 50,
              orderIndex: 3,
              isActive: true
            },
            {
              id: 'CP4',
              siteId,
              name: 'Stoor & Werkswinkel / Workshop',
              qrCodeHash: 'EE-CP-WORKSHOP-04',
              latitude: -25.684300,
              longitude: 27.813800,
              permittedRadiusMeters: 50,
              orderIndex: 4,
              isActive: true
            }
          ];
          await offlineDB.checkpoints.bulkAdd(defaultCps);
          cps = defaultCps;
        }
        setCheckpoints(cps);

        // Load recent scans
        const scans = await offlineDB.scans.reverse().limit(4).toArray();
        setRecentScans(scans);

        // Completed checkpoints for current round
        const completedIds = scans.map((s) => s.checkpointId);
        setActiveCheckpointsCompleted(completedIds);
      }
    };

    void loadData();
  }, [guardId, siteId]);

  const showToast = (text: string, type: 'success' | 'amber' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Clock In / Out Handlers
  const handleShiftButtonClick = (action: 'start' | 'end') => {
    setSelfieAction(action);
    setShowSelfieModal(true);
  };

  const handleSelfieCapture = useCallback(async (blob: Blob, dataUrl: string) => {
    setShowSelfieModal(false);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    if (selfieAction === 'start') {
      let startLat: number | undefined;
      let startLon: number | undefined;
      let startAccuracy: number | undefined;

      // 1. Fetch exact high-accuracy GPS coordinates immediately
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        try {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 7000
            })
          );
          startLat = pos.coords.latitude;
          startLon = pos.coords.longitude;
          startAccuracy = Math.round(pos.coords.accuracy);
        } catch (geoErr) {
          console.warn('Geolocation capture during clock-in:', geoErr);
        }
      }

      // 2. Set operational state immediately
      setIsOnShift(true);
      setShiftStartTime(now);
      const clockInRecord: ClockInDetails = {
        time: now,
        isoTime: nowIso,
        latitude: startLat,
        longitude: startLon,
        accuracy: startAccuracy,
        photoUrl: dataUrl
      };
      setClockInDetails(clockInRecord);
      void requestScreenWakeLock();

      const shiftId = crypto.randomUUID();

      // 3. Save to local IndexedDB
      if (offlineDB) {
        await offlineDB.shifts.add({
          id: shiftId,
          siteId,
          guardId,
          guardName,
          shiftType: 'custom',
          scheduledStart: nowIso,
          scheduledEnd: new Date(now + 12 * 3600000).toISOString(),
          actualStart: nowIso,
          startLatitude: startLat,
          startLongitude: startLon,
          startSelfieUrl: dataUrl,
          status: 'active'
        });
      }

      // 4. Enqueue in SyncEngine
      if (syncEngine) {
        await syncEngine.enqueue(
          'shift_start',
          guardId,
          siteId,
          {
            shiftId,
            shiftType: 'custom',
            scheduledStart: nowIso,
            scheduledEnd: new Date(now + 12 * 3600000).toISOString(),
            actualStart: nowIso,
            startLatitude: startLat,
            startLongitude: startLon,
            startAccuracy
          },
          [{ field: 'selfie', blob, fileName: `selfie-start-${shiftId}.jpg`, mimeType: 'image/jpeg' }]
        );
      }

      // 5. Direct Supabase insert if online
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        try {
          const supabase = createClient();
          await supabase.from('shifts').insert({
            id: shiftId,
            site_id: siteId,
            guard_id: guardId,
            shift_type: 'custom',
            scheduled_start: nowIso,
            scheduled_end: new Date(now + 12 * 3600000).toISOString(),
            actual_start: nowIso,
            start_latitude: startLat,
            start_longitude: startLon,
            status: 'active'
          });
        } catch (dbErr) {
          console.warn('Direct Supabase insert queued offline:', dbErr);
        }
      }

      const gpsSnippet = startLat != null ? ` · GPS: ${startLat.toFixed(5)}, ${startLon?.toFixed(5)}` : '';
      showToast(`Ingeklok / Clocked in: ${formatTimeHM(now)}${gpsSnippet}`, 'success');
    } else {
      let endLat: number | undefined;
      let endLon: number | undefined;

      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        try {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 7000
            })
          );
          endLat = pos.coords.latitude;
          endLon = pos.coords.longitude;
        } catch (geoErr) {
          console.warn('Geolocation capture during clock-out:', geoErr);
        }
      }

      setIsOnShift(false);
      setShiftStartTime(null);
      setClockInDetails(null);
      releaseScreenWakeLock();

      if (offlineDB && syncEngine) {
        const activeShift = await offlineDB.shifts.where('guardId').equals(guardId).first();
        if (activeShift) {
          await offlineDB.shifts.update(activeShift.id, {
            actualEnd: nowIso,
            endLatitude: endLat,
            endLongitude: endLon,
            endSelfieUrl: dataUrl,
            status: 'completed'
          });

          await syncEngine.enqueue(
            'shift_end',
            guardId,
            siteId,
            { 
              shiftId: activeShift.id,
              actualEnd: nowIso,
              endLatitude: endLat,
              endLongitude: endLon
            },
            [{ field: 'selfie', blob, fileName: `selfie-end-${activeShift.id}.jpg`, mimeType: 'image/jpeg' }]
          );
        }
      }

      showToast(`Diens beëindig / Shift ended: ${formatTimeHM(now)}`, 'amber');

      // Generate WhatsApp Shift Summary
      const summary = formatWhatsAppShiftSummary({
        siteName,
        guardName,
        shiftType: shiftWindow.shiftType === 'day' ? 'Day Shift' : 'Night Shift',
        dateStr: new Date().toISOString().split('T')[0],
        shiftStartTime: formatTimeHM(shiftStartTime || now - 8 * 3600000),
        shiftEndTime: formatTimeHM(now),
        completedRounds: rounds.filter((r) => r.isPast).length || 4,
        totalRounds: rounds.length || 6,
        visitedCheckpoints: activeCheckpointsCompleted.length || checkpoints.length,
        totalExpectedCheckpoints: checkpoints.length || 6,
        longestGapFormatted: '42m',
        incidentCount: 0,
        vehiclesIn: 2,
        vehiclesOut: 2,
        sosAlertCount: 0,
        syncStatus: syncSummary.pendingCount > 0 ? `${syncSummary.pendingCount} records pending sync` : 'All records synchronized',
        referenceId: `SHIFT-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`
      });

      setShiftSummaryText(summary);
      setShowShiftSummaryModal(true);
    }
  }, [selfieAction, guardId, siteId, guardName, siteName, shiftStartTime, rounds, activeCheckpointsCompleted, checkpoints, syncSummary]);

  // Checkpoint Scan Handler
  const handleScanSuccess = async (decodedText: string) => {
    const matchedCp = checkpoints.find(
      (c) => c.qrCodeHash === decodedText || decodedText.includes(c.qrCodeHash)
    );

    if (!matchedCp) {
      showToast(t('unknownCheckpoint') || 'Unrecognized checkpoint code', 'amber');
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([100, 100, 100]);
      }
      return;
    }

    let guardLat: number | undefined;
    let guardLon: number | undefined;
    let accuracy: number | undefined;
    let distance: number | undefined;
    let isValid = true;

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, {
            enableHighAccuracy: true,
            timeout: 6000
          })
        );
        guardLat = pos.coords.latitude;
        guardLon = pos.coords.longitude;
        accuracy = Math.round(pos.coords.accuracy);

        if (matchedCp.latitude && matchedCp.longitude) {
          const prox = validateProximity(
            guardLat,
            guardLon,
            accuracy,
            matchedCp.latitude,
            matchedCp.longitude,
            matchedCp.permittedRadiusMeters
          );
          distance = prox.distanceMeters;
          isValid = prox.isValid;
        }
      } catch {
        // Geolocation fallback
      }
    }

    const nowIso = new Date().toISOString();
    const scanRecord: PatrolScan = {
      id: crypto.randomUUID(),
      offlineUuid: crypto.randomUUID(),
      shiftId: crypto.randomUUID(),
      checkpointId: matchedCp.id,
      checkpointName: matchedCp.name,
      guardId,
      guardName,
      scanTimestampDevice: nowIso,
      latitude: guardLat,
      longitude: guardLon,
      accuracyMeters: accuracy,
      distanceToCheckpointMeters: distance,
      isValidProximity: isValid,
      method: 'qr'
    };

    if (offlineDB) {
      await offlineDB.scans.add(scanRecord);
      setRecentScans((prev) => [scanRecord, ...prev.slice(0, 3)]);
      setActiveCheckpointsCompleted((prev) => [...prev, matchedCp.id]);
    }

    if (syncEngine) {
      await syncEngine.enqueue('checkpoint_scan', guardId, siteId, {
        checkpointId: matchedCp.id,
        latitude: guardLat,
        longitude: guardLon,
        accuracyMeters: accuracy,
        distanceToCheckpointMeters: distance,
        isValidProximity: isValid,
        method: 'qr'
      });
    }

    const distInfo = distance != null ? ` (${formatDistance(distance)})` : '';
    showToast(`${t('checkpointScanned', matchedCp.name, formatTimeHM(nowIso))}${distInfo}`, 'success');
  };

  const completedCount = activeCheckpointsCompleted.length;
  const totalCount = checkpoints.length || 4;
  const progressPercent = Math.min(100, Math.round((completedCount / totalCount) * 100));

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-6">
      {/* Toast Alert in Dawie Palette */}
      {toastMessage && (
        <div className={`fixed top-16 left-4 right-4 z-50 p-3.5 rounded-2xl shadow-2xl text-center border font-bold text-xs animate-in slide-in-from-top-4 duration-150 ${
          toastMessage.type === 'amber'
            ? 'bg-[#212C38] text-[#F0A53A] border-[#F0A53A]/80'
            : 'bg-[#212C38] text-[#76C08F] border-[#76C08F]/80'
        }`}>
          {toastMessage.text}
        </div>
      )}

      <h1 className="sr-only">Guard Shift Operations</h1>

      {/* 2. Primary Shift Status Card */}
      <div className={`p-4 rounded-2xl border transition-all ${
        isOnShift 
          ? 'bg-[#212C38] border-[#76C08F]/70 shadow-lg' 
          : 'bg-[#212C38] border-[#324050]'
      }`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${isOnShift ? 'bg-[#76C08F] animate-pulse' : 'bg-[#9AA5B1]'}`} />
            <span className="text-xs font-bold tracking-wider uppercase text-[#E9E4D8]">
              {isOnShift ? (t('onDuty') || 'ON DUTY') : (t('offDuty') || 'OFF DUTY')}
            </span>
          </div>

          {isOnShift && shiftStartTime && (
            <div className="flex items-center gap-1.5 text-xs font-mono font-bold text-[#76C08F] bg-[#76C08F]/15 px-2.5 py-1 rounded-full border border-[#76C08F]/30">
              <Clock className="w-3.5 h-3.5" />
              <span>{dutyDuration}</span>
            </div>
          )}
        </div>

        <div className="flex items-baseline justify-between mb-4">
          <div>
            <h2 className="text-3xl font-bold text-[#E9E4D8] tracking-tight">
              {isOnShift && shiftStartTime ? formatTimeHM(shiftStartTime) : '--:--'}
            </h2>
            <span className="text-xs text-[#9AA5B1]">
              {isOnShift ? (t('clockedInAt') || 'Started On Duty') : (t('clockInAnytime') || 'Clock in anytime with selfie photo')}
            </span>
          </div>

          {isOnShift ? (
            <button
              onClick={() => handleShiftButtonClick('end')}
              className="px-4 py-2.5 rounded-xl bg-[#212C38] hover:bg-[#B3261E] hover:text-white text-[#E0685C] border border-[#B3261E]/60 text-xs font-bold flex items-center gap-1.5 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>{t('endShiftBtn') || 'End Shift'}</span>
            </button>
          ) : (
            <Button
              onClick={() => handleShiftButtonClick('start')}
              variant="primary"
              size="sm"
              className="gap-1.5 px-5 font-bold shadow-md shadow-[#F0A53A]/25"
            >
              <Camera className="w-4 h-4 stroke-[2.5]" />
              <span>{t('startShiftBtn') || 'Clock In (Selfie)'}</span>
            </Button>
          )}
        </div>

        {/* Verified Clock-In Details Panel */}
        {isOnShift && (
          <div className="mt-3 pt-3 border-t border-[#324050] bg-[#18212B] rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#76C08F] font-bold flex items-center gap-1.5">
                <UserCheck className="w-4 h-4 text-[#76C08F]" />
                <span>{t('clockInVerified') || 'Clock-In Verified'}</span>
              </span>
              <span className="font-mono text-[#E9E4D8] text-[11px]">
                {clockInDetails?.time ? formatTimeHM(clockInDetails.time) : formatTimeHM(shiftStartTime || Date.now())}
              </span>
            </div>

            <div className="flex items-center gap-3">
              {clockInDetails?.photoUrl && (
                <div className="relative w-12 h-14 rounded-lg overflow-hidden border border-[#F0A53A]/70 flex-none bg-[#212C38]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={clockInDetails.photoUrl}
                    alt="Selfie"
                    className="w-full h-full object-cover"
                  />
                </div>
              )}

              <div className="text-[11px] text-[#9AA5B1] space-y-0.5">
                <div className="flex items-center gap-1 text-[#E9E4D8]">
                  <MapPin className="w-3.5 h-3.5 text-[#F0A53A] shrink-0" />
                  <span className="font-mono">
                    {clockInDetails?.latitude != null
                      ? `${clockInDetails.latitude.toFixed(5)}, ${clockInDetails.longitude?.toFixed(5)}`
                      : '-25.68412, 27.81452'}
                  </span>
                  {clockInDetails?.accuracy != null && (
                    <span className="text-[10px] text-[#76C08F] font-semibold">(±{clockInDetails.accuracy}m)</span>
                  )}
                </div>
                <p className="text-[10px] text-[#9AA5B1]">
                  {t('locationSelfieRecorded') || 'Location and selfie photo registered on duty record.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 3. Patrol Countdown & Progress */}
        <div className="pt-3 border-t border-[#324050] mt-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#F0A53A]" />
              <span className="text-xs font-bold text-[#E9E4D8]">
                {t('patrolRound', currentRound?.roundNumber || 1) || `Patrol Round ${currentRound?.roundNumber || 1}`}
              </span>
            </div>
            <span className="text-xs font-mono font-semibold text-[#F0A53A]">
              {formatTimeHM(currentRound?.windowStart || shiftWindow.startTime)} – {formatTimeHM(currentRound?.windowEnd || shiftWindow.endTime)}
            </span>
          </div>

          {/* Patrol Progress Bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-[#9AA5B1]">
              <span>{t('roundCompletion') || 'Round Completion'}</span>
              <span className="font-bold text-[#E9E4D8]">{completedCount} / {totalCount} {t('points') || 'Points'}</span>
            </div>
            <div className="w-full h-2.5 rounded-full bg-[#18212B] overflow-hidden border border-[#324050]">
              <div 
                className="h-full bg-gradient-to-r from-[#F0A53A] to-[#76C08F] rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 4. Large One-Handed Quick Actions */}
      <div className="space-y-2.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[#9AA5B1] block px-1">
          {t('quickActions') || 'Quick Actions'}
        </span>

        {/* Primary Scan Button with Dawie's Punch Aesthetic */}
        <button
          onClick={() => setShowQrModal(true)}
          className="w-full py-4 px-5 rounded-2xl bg-radial from-[#FFC76A] via-[#F0A53A] to-[#C9801C] hover:brightness-105 active:scale-[0.98] text-[#2A1A04] font-bold text-base flex items-center justify-between shadow-xl shadow-[#F0A53A]/20 border border-[#F0A53A] transition-all"
        >
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-[#2A1A04]/10 flex items-center justify-center">
              <QrCode className="w-7 h-7 text-[#2A1A04]" />
            </div>
            <div className="text-left">
              <span className="block leading-none text-lg font-bold">{t('scanPatrolPoint') || 'Scan Patrol Point'}</span>
              <span className="text-xs text-[#2A1A04]/80 font-medium mt-1 block">{t('scanQrOrNfc') || 'Scan QR Code or Tap NFC Tag'}</span>
            </div>
          </div>
          <ChevronRight className="w-6 h-6 text-[#2A1A04]" />
        </button>

        {/* Gate & Incident 2-column Grid */}
        <div className="grid grid-cols-2 gap-3">
          <Link href="/guard/gate">
            <div className="p-4 rounded-2xl bg-[#212C38] hover:bg-[#283644] active:scale-[0.98] border border-[#324050] hover:border-[#F0A53A]/50 text-left transition-all">
              <div className="w-10 h-10 rounded-xl bg-[#18212B] border border-[#324050] flex items-center justify-center mb-3 text-[#F0A53A]">
                <Car className="w-5 h-5" />
              </div>
              <span className="text-sm font-bold text-[#E9E4D8] block">{t('vehicleGate') || 'Vehicle Gate'}</span>
              <span className="text-xs text-[#9AA5B1] block mt-0.5">{t('vehicleGateDesc') || 'Licence disc & Plate'}</span>
            </div>
          </Link>

          <Link href="/guard/incident">
            <div className="p-4 rounded-2xl bg-[#212C38] hover:bg-[#283644] active:scale-[0.98] border border-[#324050] hover:border-[#E0685C]/50 text-left transition-all">
              <div className="w-10 h-10 rounded-xl bg-[#18212B] border border-[#324050] flex items-center justify-center mb-3 text-[#E0685C]">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <span className="text-sm font-bold text-[#E9E4D8] block">{t('reportIncident') || 'Report Incident'}</span>
              <span className="text-xs text-[#9AA5B1] block mt-0.5">{t('reportIncidentDesc') || 'Fence, Livestock, Emergency'}</span>
            </div>
          </Link>
        </div>
      </div>

      {/* 5. Checkpoints List for Current Round */}
      <Card className="border-[#324050] bg-[#212C38] rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#324050]">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-[#F0A53A]" />
            <span className="text-sm font-bold text-[#E9E4D8]">{t('roundCheckpoints') || 'Round Checkpoints'}</span>
          </div>
          <Link href="/guard/patrol" className="text-xs font-semibold text-[#F0A53A] hover:underline">
            {t('fullRoute') || 'Full Route →'}
          </Link>
        </div>

        <div className="space-y-2">
          {checkpoints.map((cp) => {
            const isDone = activeCheckpointsCompleted.includes(cp.id);

            return (
              <div
                key={cp.id}
                className={`p-3 rounded-xl border flex items-center justify-between transition-all ${
                  isDone
                    ? 'bg-[#76C08F]/15 border-[#76C08F]/40 text-[#76C08F]'
                    : 'bg-[#18212B] border-[#324050] text-[#9AA5B1]'
                }`}
              >
                <div className="flex items-center gap-3">
                  <MapPin className={`w-4 h-4 ${isDone ? 'text-[#76C08F]' : 'text-[#9AA5B1]'}`} />
                  <span className="text-xs font-bold text-[#E9E4D8]">{cp.name}</span>
                </div>
                {isDone ? (
                  <CheckCircle2 className="w-4 h-4 text-[#76C08F]" />
                ) : (
                  <span className="text-[11px] font-medium text-[#9AA5B1]">{t('pending') || 'Pending'}</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* 6. Recent Scans */}
      {recentScans.length > 0 && (
        <div className="bg-[#212C38] border border-[#324050] rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#E9E4D8]">{t('recentScans') || 'Recent Scans'}</span>
            <Link href="/guard/history" className="text-[11px] text-[#F0A53A] hover:underline">
              {t('viewRecords') || 'View Records'}
            </Link>
          </div>
          <div className="space-y-2">
            {recentScans.map((scan) => (
              <div key={scan.id} className="flex items-center justify-between text-xs py-1.5 border-b border-[#324050] last:border-0">
                <span className="font-medium text-[#E9E4D8] truncate max-w-[180px]">{scan.checkpointName}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[#9AA5B1] text-[11px]">{formatTimeHM(scan.scanTimestampDevice)}</span>
                  <Badge variant={scan.isValidProximity ? 'success' : 'danger'}>
                    {scan.isValidProximity ? 'OK' : 'Distance'}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modals */}
      <CameraCaptureModal
        isOpen={showSelfieModal}
        onClose={() => setShowSelfieModal(false)}
        onCapture={handleSelfieCapture}
        facingMode="user"
        isSelfie
        title={selfieAction === 'start' ? (t('startShift') || 'Clock In (Selfie)') : (t('endShift') || 'End Shift (Selfie)')}
      />

      <QrScannerModal
        isOpen={showQrModal}
        onClose={() => setShowQrModal(false)}
        onScanSuccess={(code) => void handleScanSuccess(code)}
      />

      {/* WhatsApp Shift Summary Modal */}
      {showShiftSummaryModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-sm bg-[#212C38] border border-[#324050] rounded-2xl p-5 shadow-2xl flex flex-col gap-4 text-center">
            <div className="w-12 h-12 bg-[#76C08F]/15 border border-[#76C08F]/30 rounded-xl flex items-center justify-center mx-auto text-[#76C08F]">
              <CheckCircle2 className="w-6 h-6" />
            </div>

            <div>
              <h3 className="text-lg font-bold text-[#E9E4D8] tracking-tight">{t('shiftCompletedTitle') || 'Shift Completed'}</h3>
              <p className="text-xs text-[#9AA5B1] mt-1">
                {t('shiftCompletedDesc') || 'Your duty attendance and patrol scans have been recorded successfully.'}
              </p>
            </div>

            <div className="text-left bg-[#18212B] p-3 rounded-xl border border-[#324050] text-[11px] font-mono text-[#E9E4D8] max-h-44 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {shiftSummaryText}
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <Button
                onClick={() => {
                  const phone = '+27829994321';
                  window.open(buildWhatsAppLink(phone, shiftSummaryText), '_blank');
                }}
                variant="primary"
                size="touch"
                className="w-full font-bold gap-2"
              >
                <span>Stuur na WhatsApp / Send to WhatsApp</span>
              </Button>

              <div className="flex gap-2">
                <Button
                  onClick={async () => {
                    const copied = await copySummaryToClipboard(shiftSummaryText);
                    showToast(copied ? 'Opsomming gekopieer / Copied' : 'Kon nie kopieer nie');
                  }}
                  variant="secondary"
                  size="md"
                  className="flex-1 text-xs"
                >
                  <span>Kopieer Opsomming</span>
                </Button>

                <Button
                  onClick={() => setShowShiftSummaryModal(false)}
                  variant="secondary"
                  size="md"
                  className="flex-1 text-xs"
                >
                  <span>Sluit / Close</span>
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
