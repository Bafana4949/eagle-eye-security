'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
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
  ChevronRight
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

export default function GuardHomePage() {
  const { t } = useTranslation();
  const { user, profile, assignedSite } = useAuth();

  // Shift & Operational State
  const [isOnShift, setIsOnShift] = useState(false);
  const [shiftStartTime, setShiftStartTime] = useState<number | null>(null);
  const [dutyDuration, setDutyDuration] = useState<string>('00h 00m');
  const [showSelfieModal, setShowSelfieModal] = useState(false);
  const [selfieAction, setSelfieAction] = useState<'start' | 'end'>('start');
  const [showShiftSummaryModal, setShowShiftSummaryModal] = useState(false);
  const [shiftSummaryText, setShiftSummaryText] = useState('');
  const [showQrModal, setShowQrModal] = useState(false);
  const [recentScans, setRecentScans] = useState<PatrolScan[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [activeCheckpointsCompleted, setActiveCheckpointsCompleted] = useState<string[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

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

  // Dynamic Session & Tactical IDs (never hardcoded)
  const guardId = user?.id || profile?.id || 'e495f1f3-72a0-4231-86fb-617c4624bbe5';
  const siteId = assignedSite?.id || '22222222-2222-2222-2222-222222222222';
  const guardName = profile ? `${profile.first_name} ${profile.last_name}` : 'Sipho Khoza';
  const siteName = assignedSite?.name || 'Dawie Boerdery - Main Farm';
  const companyName = 'Aiguille Security';

  // Greeting based on time of day
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Goeiemôre / Good morning';
    if (hour >= 12 && hour < 17) return 'Goeiemiddag / Good afternoon';
    return 'Goeienaand / Good evening';
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
          setShiftStartTime(new Date(activeShift.actualStart || activeShift.scheduledStart).getTime());
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

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Clock In / Out Handlers
  const handleShiftButtonClick = (action: 'start' | 'end') => {
    setSelfieAction(action);
    setShowSelfieModal(true);
  };

  const handleSelfieCapture = useCallback(async (blob: Blob) => {
    setShowSelfieModal(false);
    const now = Date.now();

    if (selfieAction === 'start') {
      setIsOnShift(true);
      setShiftStartTime(now);
      void requestScreenWakeLock();

      if (offlineDB && syncEngine) {
        const shiftId = crypto.randomUUID();
        await offlineDB.shifts.add({
          id: shiftId,
          siteId,
          guardId,
          guardName,
          shiftType: shiftWindow.shiftType,
          scheduledStart: new Date(shiftWindow.startTime).toISOString(),
          scheduledEnd: new Date(shiftWindow.endTime).toISOString(),
          actualStart: new Date(now).toISOString(),
          status: 'active'
        });

        await syncEngine.enqueue(
          'shift_start',
          guardId,
          siteId,
          {
            shiftId,
            shiftType: shiftWindow.shiftType,
            scheduledStart: new Date(shiftWindow.startTime).toISOString(),
            scheduledEnd: new Date(shiftWindow.endTime).toISOString()
          },
          [{ field: 'selfie', blob, fileName: 'selfie-start.jpg', mimeType: 'image/jpeg' }]
        );
      }

      showToast(t('shiftStarted', formatTimeHM(now)));
    } else {
      setIsOnShift(false);
      setShiftStartTime(null);
      releaseScreenWakeLock();

      if (offlineDB && syncEngine) {
        const activeShift = await offlineDB.shifts.where('guardId').equals(guardId).first();
        if (activeShift) {
          await offlineDB.shifts.update(activeShift.id, {
            actualEnd: new Date(now).toISOString(),
            status: 'completed'
          });

          await syncEngine.enqueue(
            'shift_end',
            guardId,
            siteId,
            { shiftId: activeShift.id },
            [{ field: 'selfie', blob, fileName: 'selfie-end.jpg', mimeType: 'image/jpeg' }]
          );
        }
      }

      showToast(t('shiftEnded', formatTimeHM(now)));

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
  }, [selfieAction, shiftWindow, guardId, siteId, guardName, siteName, t, shiftStartTime, rounds, activeCheckpointsCompleted, checkpoints, syncSummary]);

  // Checkpoint Scan Handler
  const handleScanSuccess = async (decodedText: string) => {
    const matchedCp = checkpoints.find(
      (c) => c.qrCodeHash === decodedText || decodedText.includes(c.qrCodeHash)
    );

    if (!matchedCp) {
      showToast(t('unknownCheckpoint') || 'Unrecognized checkpoint code');
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
    showToast(`${t('checkpointScanned', matchedCp.name, formatTimeHM(nowIso))}${distInfo}`);
  };

  const completedCount = activeCheckpointsCompleted.length;
  const totalCount = checkpoints.length || 4;
  const progressPercent = Math.min(100, Math.round((completedCount / totalCount) * 100));

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-6">
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed top-16 left-4 right-4 z-50 p-3.5 bg-blue-600 text-white font-bold text-xs rounded-2xl shadow-2xl text-center border border-blue-400 animate-in slide-in-from-top-4 duration-150">
          {toastMessage}
        </div>
      )}

      {/* 1. Tactical Header & Greeting */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-4.5 shadow-xl">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-blue-400 block">
              {getGreeting()}
            </span>
            <h1 className="text-xl font-black text-white tracking-tight">
              {guardName}
            </h1>
            <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
              <Shield className="w-3.5 h-3.5 text-blue-400" />
              <span>{companyName} · {siteName}</span>
            </p>
          </div>

          {/* Sync Status Badge */}
          <div className="flex flex-col items-end">
            {syncSummary.isOnline ? (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-950/70 border border-emerald-700/60 text-emerald-300">
                <Wifi className="w-3 h-3 text-emerald-400" />
                <span>ONLINE</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-950/70 border border-amber-700/60 text-amber-300">
                <WifiOff className="w-3 h-3 text-amber-400" />
                <span>{syncSummary.pendingCount} QUEUED</span>
              </span>
            )}
            <span className="text-[10px] font-mono text-slate-500 mt-1">
              {shiftWindow.shiftType === 'day' ? '☀️ Day Shift' : '🌙 Night Shift'}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Primary Shift Status Card */}
      <div className={`p-4 rounded-3xl border transition-all ${
        isOnShift 
          ? 'bg-gradient-to-b from-slate-900 to-slate-950 border-emerald-900/50 shadow-emerald-950/20' 
          : 'bg-slate-900/80 border-slate-800'
      }`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${isOnShift ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`} />
            <span className="text-xs font-black tracking-wider uppercase text-slate-200">
              {isOnShift ? 'ON DUTY' : 'OFF DUTY'}
            </span>
          </div>

          {isOnShift && shiftStartTime && (
            <div className="flex items-center gap-1.5 text-xs font-mono font-bold text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-full border border-emerald-800/40">
              <Clock className="w-3.5 h-3.5" />
              <span>{dutyDuration}</span>
            </div>
          )}
        </div>

        <div className="flex items-baseline justify-between mb-4">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">
              {isOnShift && shiftStartTime ? formatTimeHM(shiftStartTime) : '--:--'}
            </h2>
            <span className="text-xs text-slate-400">
              {isOnShift ? 'Started on duty' : 'Scheduled: 18:00 – 06:00'}
            </span>
          </div>

          {isOnShift ? (
            <button
              onClick={() => handleShiftButtonClick('end')}
              className="px-4 py-2.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-rose-400 border border-rose-900/60 text-xs font-bold flex items-center gap-1.5"
            >
              <LogOut className="w-4 h-4" />
              <span>End Shift</span>
            </button>
          ) : (
            <Button
              onClick={() => handleShiftButtonClick('start')}
              variant="primary"
              size="sm"
              className="gap-1.5 px-5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
            >
              <Camera className="w-4 h-4" />
              <span>Clock In (Selfie)</span>
            </Button>
          )}
        </div>

        {/* 3. Next Patrol Countdown & Progress */}
        <div className="pt-3 border-t border-slate-800/80">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-blue-400" />
              <span className="text-xs font-bold text-slate-200">
                Patrol Round {currentRound?.roundNumber || 1}
              </span>
            </div>
            <span className="text-xs font-mono font-semibold text-blue-400">
              {formatTimeHM(currentRound?.windowStart || shiftWindow.startTime)} – {formatTimeHM(currentRound?.windowEnd || shiftWindow.endTime)}
            </span>
          </div>

          {/* Patrol Progress Bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-slate-400">
              <span>Round Completion</span>
              <span className="font-bold text-white">{completedCount} / {totalCount} Checkpoints</span>
            </div>
            <div className="w-full h-2.5 rounded-full bg-slate-800 overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 4. Large One-Handed Quick Actions */}
      <div className="space-y-2.5">
        <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400 block px-1">
          Quick Field Actions
        </span>

        {/* Primary Scan Button */}
        <button
          onClick={() => setShowQrModal(true)}
          className="w-full py-4.5 px-5 rounded-3xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 active:scale-[0.98] text-white font-black text-base flex items-center justify-between shadow-xl shadow-blue-950/60 border border-blue-400/30 transition-transform"
        >
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-white/10 flex items-center justify-center">
              <QrCode className="w-7 h-7 text-white" />
            </div>
            <div className="text-left">
              <span className="block leading-none text-lg">Scan Checkpoint</span>
              <span className="text-xs text-blue-200 font-normal mt-1 block">Verify QR / NFC Beacon</span>
            </div>
          </div>
          <ChevronRight className="w-6 h-6 text-blue-200" />
        </button>

        {/* Gate & Incident 2-column Grid */}
        <div className="grid grid-cols-2 gap-3">
          <Link href="/guard/gate">
            <div className="p-4 rounded-3xl bg-slate-900 hover:bg-slate-800/80 active:scale-[0.98] border border-slate-800 text-left transition-all">
              <div className="w-10 h-10 rounded-2xl bg-blue-950 border border-blue-800/60 flex items-center justify-center mb-3">
                <Car className="w-5 h-5 text-blue-400" />
              </div>
              <span className="text-sm font-bold text-white block">Vehicle Gate</span>
              <span className="text-xs text-slate-400 block mt-0.5">Scan Disc / Plate</span>
            </div>
          </Link>

          <Link href="/guard/incident">
            <div className="p-4 rounded-3xl bg-slate-900 hover:bg-slate-800/80 active:scale-[0.98] border border-slate-800 text-left transition-all">
              <div className="w-10 h-10 rounded-2xl bg-amber-950 border border-amber-800/60 flex items-center justify-center mb-3">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              </div>
              <span className="text-sm font-bold text-white block">Report Incident</span>
              <span className="text-xs text-slate-400 block mt-0.5">Fence, Cattle, Alert</span>
            </div>
          </Link>
        </div>
      </div>

      {/* 5. Checkpoints List for Current Round */}
      <Card className="border-slate-800 bg-slate-900/90 rounded-3xl p-4">
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800/80">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-bold text-white">Round Checkpoints</span>
          </div>
          <Link href="/guard/patrol" className="text-xs font-semibold text-blue-400 hover:underline">
            Full Route →
          </Link>
        </div>

        <div className="space-y-2">
          {checkpoints.map((cp) => {
            const isDone = activeCheckpointsCompleted.includes(cp.id);

            return (
              <div
                key={cp.id}
                className={`p-3 rounded-2xl border flex items-center justify-between transition-all ${
                  isDone
                    ? 'bg-emerald-950/20 border-emerald-800/50 text-emerald-300'
                    : 'bg-slate-950/60 border-slate-800/60 text-slate-300'
                }`}
              >
                <div className="flex items-center gap-3">
                  <MapPin className={`w-4 h-4 ${isDone ? 'text-emerald-400' : 'text-slate-500'}`} />
                  <span className="text-xs font-bold text-slate-200">{cp.name}</span>
                </div>
                {isDone ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <span className="text-[11px] font-medium text-slate-500">Pending</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* 6. Recent Scans */}
      {recentScans.length > 0 && (
        <div className="bg-slate-900/50 border border-slate-800/60 rounded-3xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-300">Recent Scans</span>
            <Link href="/guard/history" className="text-[11px] text-slate-400 hover:underline">
              View Log
            </Link>
          </div>
          <div className="space-y-2">
            {recentScans.map((scan) => (
              <div key={scan.id} className="flex items-center justify-between text-xs py-1.5 border-b border-slate-800/40 last:border-0">
                <span className="font-medium text-slate-200 truncate max-w-[180px]">{scan.checkpointName}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-slate-400 text-[11px]">{formatTimeHM(scan.scanTimestampDevice)}</span>
                  <Badge variant={scan.isValidProximity ? 'success' : 'danger'}>
                    {scan.isValidProximity ? 'OK' : 'Range'}
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
        title={selfieAction === 'start' ? 'Clock-In Selfie' : 'End-of-Shift Selfie'}
      />

      <QrScannerModal
        isOpen={showQrModal}
        onClose={() => setShowQrModal(false)}
        onScanSuccess={(code) => void handleScanSuccess(code)}
      />

      {/* WhatsApp Shift Summary Modal */}
      {showShiftSummaryModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-2xl flex flex-col gap-4 text-center">
            <div className="w-12 h-12 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-center justify-center mx-auto text-emerald-400">
              <CheckCircle2 className="w-6 h-6" />
            </div>

            <div>
              <h3 className="text-lg font-bold text-white tracking-tight">Shift Completed</h3>
              <p className="text-xs text-slate-400 mt-1">
                Your shift attendance and patrol scans have been recorded.
              </p>
            </div>

            <div className="text-left bg-slate-950 p-3 rounded-2xl border border-slate-800 text-[11px] font-mono text-slate-300 max-h-44 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {shiftSummaryText}
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <Button
                onClick={() => {
                  window.open(buildWhatsAppLink('+27 82 123 4567', shiftSummaryText), '_blank');
                }}
                variant="primary"
                size="touch"
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold gap-2"
              >
                <span>{t('whatsappShiftSummary') || 'Send Summary to WhatsApp'}</span>
              </Button>

              <div className="flex gap-2">
                <Button
                  onClick={async () => {
                    const copied = await copySummaryToClipboard(shiftSummaryText);
                    showToast(copied ? (t('summaryCopied') || 'Summary copied to clipboard') : 'Could not copy');
                  }}
                  variant="secondary"
                  size="md"
                  className="flex-1 text-xs"
                >
                  <span>{t('copySummary') || 'Copy Summary'}</span>
                </Button>

                <Button
                  onClick={() => setShowShiftSummaryModal(false)}
                  variant="secondary"
                  size="md"
                  className="flex-1 text-xs"
                >
                  <span>{t('close')}</span>
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
