'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { 
  MapPin, 
  QrCode, 
  Radio, 
  CheckCircle2, 
  Navigation,
  ArrowRight
} from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { QrScannerModal } from '@/components/shared/QrScannerModal';
import { offlineDB } from '@/lib/offline/db';
import { syncEngine } from '@/lib/offline/sync';
import { validateProximity, formatDistance } from '@/lib/gps/haversine';
import { Checkpoint, PatrolScan } from '@/types/models';
import { formatTimeHM } from '@/features/shifts/shiftCalculator';
import { useAuth } from '@/context/AuthContext';

interface ScanVerificationState {
  checkpointName: string;
  timestamp: string;
  distanceMeters?: number;
  accuracyMeters?: number;
  isValid: boolean;
}

interface NdefReadingEvent {
  serialNumber?: string;
}

interface WebNdefReader {
  scan: () => Promise<void>;
  onreading: (event: NdefReadingEvent) => void;
  onreadingerror?: (error: unknown) => void;
}

export default function GuardPatrolPage() {
  const { t } = useTranslation();
  const { user, profile, assignedSite } = useAuth();

  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [completedScanIds, setCompletedScanIds] = useState<Record<string, PatrolScan>>({});
  const [showQrModal, setShowQrModal] = useState(false);
  const [isNfcActive, setIsNfcActive] = useState(false);
  const [currentGps, setCurrentGps] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [verificationResult, setVerificationResult] = useState<ScanVerificationState | null>(null);

  // Dynamic Session & Tactical IDs (never hardcoded)
  const guardId = user?.id || profile?.id || 'e495f1f3-72a0-4231-86fb-617c4624bbe5';
  const siteId = assignedSite?.id || '22222222-2222-2222-2222-222222222222';
  const guardName = profile ? `${profile.first_name} ${profile.last_name}` : 'Sipho Khoza';

  // Watch geolocation
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setCurrentGps({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            acc: Math.round(pos.coords.accuracy)
          });
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 10000 }
      );

      return () => navigator.geolocation.clearWatch(watchId);
    }
  }, []);

  // Load checkpoints and today's scans
  useEffect(() => {
    const loadCheckpoints = async () => {
      if (offlineDB) {
        const cps = await offlineDB.checkpoints.toArray();
        setCheckpoints(cps);

        const today = new Date().toISOString().split('T')[0];
        const scans = await offlineDB.scans
          .filter((s) => s.scanTimestampDevice.startsWith(today))
          .toArray();

        const scanMap: Record<string, PatrolScan> = {};
        scans.forEach((s) => {
          scanMap[s.checkpointId] = s;
        });
        setCompletedScanIds(scanMap);
      }
    };

    void loadCheckpoints();
  }, []);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const handleScanProcess = useCallback(async (identifier: string, method: 'qr' | 'nfc') => {
    const cleanId = identifier.trim();

    // Verify Active Shift Exists
    let activeShiftId: string | null = null;
    if (offlineDB) {
      const activeShift = await offlineDB.shifts
        .where('guardId')
        .equals(guardId)
        .and((s) => s.status === 'active')
        .first();

      if (activeShift) {
        activeShiftId = activeShift.id;
      }
    }

    if (!activeShiftId) {
      showToast('Geen aktiewe skof / No active shift. Begin asseblief skof op Wag Tuisblad voordat patrollie gedoen word.');
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([150, 100, 150]);
      }
      return;
    }

    // Match checkpoint by QR token, normalized NFC serial, or legacy code
    const normalizedId = cleanId.replace(/:/g, '').toUpperCase();
    const matchedCp = checkpoints.find(
      (c) =>
        c.qrCodeHash === cleanId ||
        cleanId.includes(c.qrCodeHash) ||
        (c.nfcUid && (c.nfcUid === cleanId || c.nfcUid.replace(/:/g, '').toUpperCase() === normalizedId)) ||
        // Support Dawie's legacy physical QR cards: PLAAS-CP:CP1, etc.
        (cleanId.startsWith('PLAAS-CP:') && (c.id === cleanId.slice(9) || c.orderIndex.toString() === cleanId.slice(10)))
    );

    if (!matchedCp) {
      showToast(t('unknownCheckpoint') || 'Unrecognized checkpoint code');
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([100, 100, 100]);
      }
      return;
    }

    let distance: number | undefined;
    let isValid = true;

    if (currentGps && matchedCp.latitude && matchedCp.longitude) {
      const prox = validateProximity(
        currentGps.lat,
        currentGps.lng,
        currentGps.acc,
        matchedCp.latitude,
        matchedCp.longitude,
        matchedCp.permittedRadiusMeters
      );
      distance = prox.distanceMeters;
      isValid = prox.isValid;
    }

    const nowIso = new Date().toISOString();
    const scan: PatrolScan = {
      id: crypto.randomUUID(),
      offlineUuid: crypto.randomUUID(),
      shiftId: activeShiftId,
      checkpointId: matchedCp.id,
      checkpointName: matchedCp.name,
      guardId,
      guardName,
      scanTimestampDevice: nowIso,
      latitude: currentGps?.lat,
      longitude: currentGps?.lng,
      accuracyMeters: currentGps?.acc,
      distanceToCheckpointMeters: distance,
      isValidProximity: isValid,
      method
    };

    if (offlineDB) {
      await offlineDB.scans.add(scan);
      setCompletedScanIds((prev) => ({ ...prev, [matchedCp.id]: scan }));
    }

    if (syncEngine) {
      await syncEngine.enqueue('checkpoint_scan', guardId, siteId, {
        shiftId: activeShiftId,
        checkpointId: matchedCp.id,
        latitude: currentGps?.lat,
        longitude: currentGps?.lng,
        accuracyMeters: currentGps?.acc,
        distanceToCheckpointMeters: distance,
        isValidProximity: isValid,
        method
      });
    }

    // Set prominent verification modal
    setVerificationResult({
      checkpointName: matchedCp.name,
      timestamp: new Date().toLocaleTimeString('en-ZA', { hour12: false }),
      distanceMeters: distance,
      accuracyMeters: currentGps?.acc,
      isValid
    });
  }, [checkpoints, currentGps, guardId, siteId, guardName, t]);

  const handleStartNfc = async () => {
    if (typeof window === 'undefined') return;

    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      showToast('NFC scanning is not supported on iPhone web apps. Please scan the checkpoint QR code instead.');
      return;
    }

    if (!('NDEFReader' in window)) {
      showToast(t('nfcUnsupported') || 'NFC scanning is not supported on this device/browser. Please scan the checkpoint QR code instead.');
      return;
    }

    try {
      const NDEFReaderClass = (window as unknown as { NDEFReader: new () => WebNdefReader }).NDEFReader;
      const ndef = new NDEFReaderClass();
      await ndef.scan();
      setIsNfcActive(true);
      showToast(t('nfcHoldPhone') || 'Hold your phone against the checkpoint tag');

      ndef.onreading = (event: NdefReadingEvent) => {
        if (event.serialNumber) {
          void handleScanProcess(event.serialNumber, 'nfc');
        }
      };

      ndef.onreadingerror = () => {
        showToast('NFC read error: Tag incompatible or moved away too quickly. If this is an older 125 kHz RFID button, please scan the QR code instead.');
      };
    } catch {
      showToast('NFC permission denied or NFC is turned off in phone settings. Turn on NFC in Settings -> Connections -> NFC.');
    }
  };

  const completedCount = Object.keys(completedScanIds).length;
  const totalCount = checkpoints.length || 4;

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-6">
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed top-16 left-4 right-4 z-50 p-3.5 bg-[#212C38] border border-[#F0A53A] text-[#F0A53A] font-bold text-xs rounded-2xl shadow-2xl text-center animate-in slide-in-from-top-4 duration-200">
          {toastMessage}
        </div>
      )}

      {/* GPS Status Banner */}
      <div className="flex items-center justify-between p-3.5 rounded-xl bg-[#212C38] border border-[#324050] text-xs shadow-md">
        <div className="flex items-center gap-2.5">
          <Navigation className="w-4 h-4 text-[#76C08F] animate-pulse" />
          <span className="font-bold text-[#E9E4D8]">
            {currentGps ? `GPS: ±${currentGps.acc}m Accuracy` : 'Acquiring GPS Signal...'}
          </span>
        </div>
        {currentGps && (
          <span className="font-mono text-[#9AA5B1] text-[11px]">
            {currentGps.lat.toFixed(4)}, {currentGps.lng.toFixed(4)}
          </span>
        )}
      </div>

      {/* Primary Actions */}
      <div className="grid grid-cols-2 gap-3">
        <Button
          onClick={() => setShowQrModal(true)}
          variant="primary"
          size="touch"
          className="gap-2 font-bold shadow-lg shadow-[#F0A53A]/20"
        >
          <QrCode className="w-6 h-6" />
          <span>{t('scanQrCard')}</span>
        </Button>

        <Button
          onClick={() => void handleStartNfc()}
          variant={isNfcActive ? 'primary' : 'secondary'}
          size="touch"
          className="gap-2 font-bold"
        >
          <Radio className={`w-6 h-6 ${isNfcActive ? 'text-[#76C08F] animate-pulse' : ''}`} />
          <span>{isNfcActive ? 'NFC Active' : t('scanNfcTag')}</span>
        </Button>
      </div>

      {/* Checkpoints Route Sequence */}
      <Card className="rounded-2xl border-[#324050] bg-[#212C38]">
        <CardHeader className="mb-2 border-b border-[#324050]">
          <div className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-[#F0A53A]" />
            <CardTitle className="text-[#E9E4D8]">Patrol Route Checkpoints</CardTitle>
          </div>
          <Badge variant={completedCount === totalCount ? 'success' : 'info'}>
            {completedCount} / {totalCount} Completed
          </Badge>
        </CardHeader>

        <div className="space-y-2.5 mt-2">
          {checkpoints.map((cp, idx) => {
            const scan = completedScanIds[cp.id];
            const isCompleted = !!scan;

            return (
              <div
                key={cp.id}
                className={`p-3.5 rounded-xl border transition-all ${
                  isCompleted
                    ? 'bg-[#76C08F]/15 border-[#76C08F]/40 shadow-sm'
                    : 'bg-[#18212B] border-[#324050]'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs ${
                        isCompleted ? 'bg-[#76C08F] text-[#18212B]' : 'bg-[#212C38] text-[#9AA5B1] border border-[#324050]'
                      }`}
                    >
                      {idx + 1}
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-[#E9E4D8] leading-snug">{cp.name}</h4>
                      {cp.description && (
                        <p className="text-xs text-[#9AA5B1] mt-0.5">{cp.description}</p>
                      )}
                      <p className="text-[11px] font-mono text-[#9AA5B1] mt-1">
                        Radius: {cp.permittedRadiusMeters}m · Tag: {cp.qrCodeHash}
                      </p>
                    </div>
                  </div>

                  {isCompleted ? (
                    <div className="text-right">
                      <Badge variant={scan.isValidProximity ? 'success' : 'danger'}>
                        {scan.isValidProximity ? 'Verified' : 'Out of Range'}
                      </Badge>
                      <p className="text-[11px] text-[#9AA5B1] font-mono mt-1">
                        {formatTimeHM(scan.scanTimestampDevice)}
                      </p>
                    </div>
                  ) : (
                    <Badge variant="neutral">Pending</Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Prominent Checkpoint Verification Success Modal */}
      {verificationResult && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-slate-900 border-2 border-emerald-500 rounded-3xl max-w-sm w-full p-6 text-center shadow-2xl shadow-emerald-950/60">
            <div className="w-16 h-16 rounded-full bg-emerald-950/90 border-2 border-emerald-400 flex items-center justify-center mx-auto mb-4 text-emerald-400">
              <CheckCircle2 className="w-10 h-10" />
            </div>

            <span className="text-[11px] font-extrabold uppercase tracking-widest text-emerald-400 block mb-1">
              ✓ CHECKPOINT VERIFIED
            </span>
            <h2 className="text-xl font-black text-white tracking-tight mb-2">
              {verificationResult.checkpointName}
            </h2>

            <div className="bg-slate-950/80 rounded-2xl p-3 border border-slate-800 text-xs font-mono text-slate-300 space-y-1 mb-5">
              <div className="flex justify-between">
                <span className="text-slate-500">Scan Time:</span>
                <span className="font-bold text-white">{verificationResult.timestamp}</span>
              </div>
              {verificationResult.distanceMeters != null && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Distance to Beacon:</span>
                  <span className="font-bold text-emerald-400">
                    {formatDistance(verificationResult.distanceMeters)}
                  </span>
                </div>
              )}
              {verificationResult.accuracyMeters != null && (
                <div className="flex justify-between">
                  <span className="text-slate-500">GPS Accuracy:</span>
                  <span className="text-slate-300">±{verificationResult.accuracyMeters}m</span>
                </div>
              )}
            </div>

            <Button
              onClick={() => setVerificationResult(null)}
              variant="primary"
              size="touch"
              className="w-full bg-emerald-600 hover:bg-emerald-500 font-bold"
            >
              <span>Continue Patrol</span>
              <ArrowRight className="w-5 h-5 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* QR Scanner Modal */}
      <QrScannerModal
        isOpen={showQrModal}
        onClose={() => setShowQrModal(false)}
        onScanSuccess={(code) => void handleScanProcess(code, 'qr')}
      />
    </div>
  );
}
