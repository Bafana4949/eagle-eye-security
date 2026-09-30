'use client';

import React, { useState, useRef } from 'react';
import { AlertOctagon, PhoneCall, ShieldAlert, X, CheckCircle, Radio } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { syncEngine } from '@/lib/offline/sync';
import { offlineDB } from '@/lib/offline/db';

interface SosPanicModalProps {
  userId: string;
  siteId: string;
  shiftId?: string;
  guardName?: string;
  supervisorPhone?: string;
  policePhone?: string;
}

type AlertStage = 'holding' | 'triggered';

export function SosPanicModal({
  userId,
  siteId,
  shiftId,
  guardName,
  supervisorPhone = '+27829994321',
  policePhone = '10111'
}: SosPanicModalProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [stage, setStage] = useState<AlertStage>('holding');
  const [isArmed, setIsArmed] = useState(false);
  const [progress, setProgress] = useState(0); // 0 to 100
  const [locationSummary, setLocationSummary] = useState<string>('Detecting GPS...');
  const [deliveryStatus, setDeliveryStatus] = useState<'queued' | 'sent' | 'acknowledged'>('queued');

  const pressStartRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);

  const HOLD_DURATION_MS = 2000; // 2 seconds deliberate hold to prevent accidental trigger

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    pressStartRef.current = Date.now();
    setIsArmed(false);
    setProgress(0);

    const step = () => {
      const elapsed = Date.now() - pressStartRef.current;
      const pct = Math.min(100, (elapsed / HOLD_DURATION_MS) * 100);
      setProgress(pct);

      if (pct >= 100) {
        setIsArmed(true);
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate([300, 100, 300]);
        }
      } else {
        animationFrameRef.current = requestAnimationFrame(step);
      }
    };

    animationFrameRef.current = requestAnimationFrame(step);
  };

  const handlePointerUp = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (isArmed) {
      void triggerPanicAlert();
    }

    setProgress(0);
    setIsArmed(false);
  };

  const handlePointerCancel = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setProgress(0);
    setIsArmed(false);
  };

  const triggerPanicAlert = async () => {
    setStage('triggered');

    let lat: number | undefined;
    let lon: number | undefined;
    let acc: number | undefined;

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 6000
          });
        });
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
        acc = Math.round(pos.coords.accuracy);
        setLocationSummary(`${lat.toFixed(5)}, ${lon.toFixed(5)} (±${acc}m)`);
      } catch {
        setLocationSummary('GPS Signal Unavailable');
      }
    }

    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    setDeliveryStatus(isOnline ? 'sent' : 'queued');

    // Save to local offline queue & sync
    if (syncEngine && offlineDB) {
      await syncEngine.enqueue('panic', userId, siteId, {
        shiftId,
        guardName,
        latitude: lat,
        longitude: lon,
        accuracyMeters: acc
      });
    }

    // Emergency vibration rhythm
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([500, 200, 500, 200, 500]);
    }
  };

  return (
    <>
      {/* Persistent Floating SOS Button */}
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-20 right-4 z-40 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-black px-4 py-3 rounded-full shadow-2xl shadow-rose-950/70 flex items-center gap-2 border-2 border-rose-400 select-none animate-pulse"
        aria-label="Emergency SOS Panic Button"
      >
        <AlertOctagon className="w-5 h-5 text-white" />
        <span className="text-sm font-black tracking-wider">SOS</span>
      </button>

      {/* SOS Modal Dialog */}
      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border-2 border-rose-600 rounded-3xl max-w-sm w-full p-6 text-center shadow-2xl shadow-rose-950/80 relative">
            <button
              onClick={() => {
                setIsOpen(false);
                setStage('holding');
              }}
              className="absolute top-4 right-4 text-slate-400 hover:text-white p-2"
            >
              <X className="w-6 h-6" />
            </button>

            {stage === 'holding' ? (
              <div className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full bg-rose-950/80 border-2 border-rose-600 flex items-center justify-center mb-4 text-rose-500">
                  <ShieldAlert className="w-9 h-9" />
                </div>

                <h2 className="text-2xl font-black text-rose-500 tracking-tight mb-1">
                  EMERGENCY SOS
                </h2>
                <p className="text-xs text-slate-300 mb-5 font-medium leading-relaxed">
                  {isArmed ? 'RELEASE NOW TO TRANSMIT ALERT' : 'Press and hold for 2 seconds to trigger emergency broadcast'}
                </p>

                {/* Tactile Press & Hold Button */}
                <div
                  onPointerDown={handlePointerDown}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                  onPointerLeave={handlePointerCancel}
                  className="relative w-full h-20 rounded-2xl bg-rose-950/80 border-2 border-rose-600 overflow-hidden cursor-pointer select-none flex items-center justify-center shadow-inner active:scale-[0.98] transition-transform"
                >
                  {/* Progress Fill Bar */}
                  <div
                    className={`absolute left-0 top-0 bottom-0 transition-all ${
                      isArmed ? 'bg-rose-500' : 'bg-rose-600/70'
                    }`}
                    style={{ width: `${progress}%` }}
                  />

                  <span className="relative z-10 font-black text-base tracking-wider text-white flex items-center gap-2">
                    <AlertOctagon className="w-6 h-6" />
                    {isArmed ? 'RELEASE TO BROADCAST' : t('panicButton')}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center animate-in zoom-in-95 duration-150">
                <div className="w-16 h-16 rounded-full bg-rose-600 flex items-center justify-center mb-3 text-white animate-bounce shadow-lg shadow-rose-950">
                  <AlertOctagon className="w-9 h-9" />
                </div>

                <h2 className="text-xl font-black text-rose-500 mb-1">
                  EMERGENCY ALERT SENT
                </h2>
                <p className="text-xs font-mono text-slate-300 mb-3">{locationSummary}</p>

                {/* Status Progression Lifecycle */}
                <div className="w-full bg-slate-950 border border-slate-800 rounded-2xl p-3 text-xs mb-5 space-y-1.5 font-mono">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500">Transmission:</span>
                    <span className="font-bold text-emerald-400 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>{deliveryStatus.toUpperCase()}</span>
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500">Dispatch:</span>
                    <span className="font-bold text-[#F0A53A] flex items-center gap-1">
                      <Radio className="w-3.5 h-3.5 animate-pulse" />
                      <span>SUPERVISOR NOTIFIED</span>
                    </span>
                  </div>
                </div>

                <div className="w-full flex flex-col gap-2.5">
                  <a
                    href={`tel:${supervisorPhone}`}
                    className="w-full py-4 px-6 bg-[#F0A53A] hover:bg-[#FFC76A] text-[#2A1A04] font-bold text-sm rounded-2xl flex items-center justify-center gap-2 shadow-lg shadow-[#F0A53A]/20 border border-[#F0A53A]"
                  >
                    <PhoneCall className="w-5 h-5" />
                    <span>Call Supervisor Directly</span>
                  </a>

                  <a
                    href={`tel:${policePhone}`}
                    className="w-full py-3.5 px-6 bg-slate-800 hover:bg-slate-700 text-rose-400 border border-rose-900 font-bold text-xs rounded-2xl flex items-center justify-center gap-2"
                  >
                    <PhoneCall className="w-4 h-4" />
                    <span>Call Police Emergency (10111)</span>
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
