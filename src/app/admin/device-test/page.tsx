'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { 
  ArrowLeft, 
  Camera, 
  Navigation, 
  QrCode, 
  Radio, 
  Database, 
  Wifi, 
  Volume2, 
  Sun, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  RefreshCw,
  Smartphone,
  Info,
  LogOut
} from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/context/AuthContext';
import { triggerAlarmBeep, requestScreenWakeLock, releaseScreenWakeLock } from '@/lib/patrol/alarm';
import { isNativePdf417Supported } from '@/lib/license-disc/scanner';

interface DiagnosticStatus {
  status: 'supported' | 'unsupported' | 'pending' | 'denied';
  details: string;
}

interface NdefReadRecord {
  recordType?: string;
  mediaType?: string;
  data?: unknown;
}

interface NdefReadingEvent {
  serialNumber?: string;
  message?: {
    records?: NdefReadRecord[];
  };
}

interface WebNdefReader {
  scan: () => Promise<void>;
  onreading: (event: NdefReadingEvent) => void;
  onreadingerror: (error: unknown) => void;
}

export default function DeviceHardwareTestPage() {
  const router = useRouter();
  const { signOut } = useAuth();
  const [cameraStatus, setCameraStatus] = useState<DiagnosticStatus>({ status: 'pending', details: 'Checking...' });
  const [gpsStatus, setGpsStatus] = useState<DiagnosticStatus>({ status: 'pending', details: 'Checking...' });
  const [nfcStatus, setNfcStatus] = useState<DiagnosticStatus>({ status: 'pending', details: 'Checking...' });
  const [idbStatus, setIdbStatus] = useState<DiagnosticStatus>({ status: 'pending', details: 'Checking...' });
  const [swStatus, setSwStatus] = useState<DiagnosticStatus>({ status: 'pending', details: 'Checking...' });
  const [pwaStatus, setPwaStatus] = useState<DiagnosticStatus>({ status: 'pending', details: 'Checking...' });
  const [pdf417Status, setPdf417Status] = useState<DiagnosticStatus>({ status: 'pending', details: 'Checking...' });
  const [networkStatus, setNetworkStatus] = useState<DiagnosticStatus>({ status: 'pending', details: 'Checking...' });

  // Interactive Test State
  const [testedNfcTag, setTestedNfcTag] = useState<{ serial?: string; records?: string; error?: string } | null>(null);
  const [isNfcTesting, setIsNfcTesting] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [audioPlayed, setAudioPlayed] = useState(false);

  const runDiagnostics = useCallback(async () => {
    // 1. Camera check
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        stream.getTracks().forEach((t) => t.stop());
        setCameraStatus({ status: 'supported', details: 'Camera hardware active & permission granted' });
      } catch (err: unknown) {
        const error = err as Error;
        if (error.name === 'NotAllowedError') {
          setCameraStatus({ status: 'denied', details: 'Camera permission denied by browser or user' });
        } else {
          setCameraStatus({ status: 'unsupported', details: `Camera unavailable: ${error.message}` });
        }
      }
    } else {
      setCameraStatus({ status: 'unsupported', details: 'navigator.mediaDevices.getUserMedia not supported' });
    }

    // 2. GPS Check
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGpsStatus({
            status: 'supported',
            details: `GPS Fix acquired: ±${Math.round(pos.coords.accuracy)}m (${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)})`
          });
        },
        (err) => {
          setGpsStatus({
            status: err.code === 1 ? 'denied' : 'unsupported',
            details: `GPS error (${err.code}): ${err.message}`
          });
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    } else {
      setGpsStatus({ status: 'unsupported', details: 'navigator.geolocation not supported' });
    }

    // 3. Web NFC Check
    if (typeof window !== 'undefined') {
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const isHttps = window.location.protocol === 'https:' || window.location.hostname === 'localhost';

      if (isIOS) {
        setNfcStatus({
          status: 'unsupported',
          details: 'iOS Safari does not support the Web NFC API. Use checkpoint QR codes on iPhones.'
        });
      } else if (!isHttps) {
        setNfcStatus({
          status: 'unsupported',
          details: 'Web NFC requires a secure HTTPS context. Serve over https://.'
        });
      } else if ('NDEFReader' in window) {
        setNfcStatus({
          status: 'supported',
          details: 'Web NFC API is available in this browser (compatible with 13.56MHz NDEF tags).'
        });
      } else {
        setNfcStatus({
          status: 'unsupported',
          details: 'Web NFC not supported in this browser. Use Google Chrome on Android.'
        });
      }
    }

    // 4. IndexedDB Check
    if (typeof window !== 'undefined' && 'indexedDB' in window) {
      setIdbStatus({ status: 'supported', details: 'IndexedDB persistent client database available' });
    } else {
      setIdbStatus({ status: 'unsupported', details: 'IndexedDB is unavailable' });
    }

    // 5. Service Worker Check
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      if (registrations.length > 0) {
        setSwStatus({ status: 'supported', details: `Service Worker registered (${registrations[0].scope})` });
      } else {
        setSwStatus({ status: 'pending', details: 'Service Worker API supported; registering on reload' });
      }
    } else {
      setSwStatus({ status: 'unsupported', details: 'Service Workers not supported' });
    }

    // 6. PWA Mode
    if (typeof window !== 'undefined') {
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches || ('standalone' in navigator && (navigator as unknown as { standalone: boolean }).standalone);
      setPwaStatus({
        status: 'supported',
        details: isStandalone ? 'App is installed and running in Standalone PWA mode' : 'App is running in web browser tab (installable)'
      });
    }

    // 7. Native PDF417 Support
    const nativePdf417 = await isNativePdf417Supported();
    setPdf417Status({
      status: 'supported',
      details: nativePdf417 
        ? 'Hardware-accelerated BarcodeDetector (PDF417) active' 
        : 'ZXing MultiFormatReader (PDF417) software fallback active'
    });

    // 8. Online Connectivity
    setNetworkStatus({
      status: navigator.onLine ? 'supported' : 'unsupported',
      details: navigator.onLine ? 'Internet connectivity active' : 'Device is offline'
    });
  }, []);

  useEffect(() => {
    let isMounted = true;
    const timer = setTimeout(() => {
      if (isMounted) {
        void runDiagnostics();
      }
    }, 0);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [runDiagnostics]);

  const handleTestNfcTag = async () => {
    if (typeof window === 'undefined' || !('NDEFReader' in window)) {
      setTestedNfcTag({ error: 'Web NFC is not supported on this device or browser.' });
      return;
    }

    setIsNfcTesting(true);
    setTestedNfcTag(null);

    try {
      const NDEFReaderClass = (window as unknown as { NDEFReader: new () => WebNdefReader }).NDEFReader;
      const reader = new NDEFReaderClass();
      await reader.scan();

      reader.onreading = (event: NdefReadingEvent) => {
        setIsNfcTesting(false);
        const serial = event.serialNumber || 'N/A';
        const records = event.message?.records?.map((r) => r.recordType || 'record').join(', ') || 'Empty NDEF payload';
        setTestedNfcTag({ serial, records });
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate(200);
        }
      };

      reader.onreadingerror = () => {
        setIsNfcTesting(false);
        setTestedNfcTag({
          error: 'This physical RFID technology cannot be read directly by the web browser. Use a compatible 13.56 MHz NFC/NDEF checkpoint tag, QR fallback, or supported external reader.'
        });
      };
    } catch (err: unknown) {
      setIsNfcTesting(false);
      const error = err as Error;
      setTestedNfcTag({ error: `NFC scan could not start: ${error.message}` });
    }
  };

  const handleTestAudio = () => {
    triggerAlarmBeep(true);
    setAudioPlayed(true);
  };

  const handleToggleWakeLock = async () => {
    if (wakeLockActive) {
      releaseScreenWakeLock();
      setWakeLockActive(false);
    } else {
      const success = await requestScreenWakeLock();
      setWakeLockActive(success);
    }
  };

  const renderBadge = (status: DiagnosticStatus['status']) => {
    switch (status) {
      case 'supported':
        return (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Passed</span>
          </Badge>
        );
      case 'denied':
        return (
          <Badge variant="danger" className="gap-1">
            <XCircle className="w-3.5 h-3.5" />
            <span>Permission Denied</span>
          </Badge>
        );
      case 'unsupported':
        return (
          <Badge variant="warning" className="gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Unsupported / Fallback</span>
          </Badge>
        );
      default:
        return (
          <Badge variant="neutral" className="gap-1">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Checking</span>
          </Badge>
        );
    }
  };

  return (
    <div className="min-h-screen bg-[#18212B] text-[#E9E4D8] flex flex-col font-sans pb-12">
      {/* Top Header */}
      <header className="sticky top-0 z-30 bg-[#18212B]/95 backdrop-blur-md border-b border-[#324050] px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="p-2 rounded-xl bg-[#212C38] border border-[#324050] text-[#9AA5B1] hover:text-[#E9E4D8]">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-lg font-bold text-[#E9E4D8] tracking-tight flex items-center gap-2">
                <span>Device & Hardware Diagnostic Test</span>
              </h1>
              <p className="text-xs text-[#9AA5B1]">Validate smartphone sensors, cameras, NFC & storage</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={() => void runDiagnostics()} variant="secondary" size="sm" className="gap-1.5 text-xs">
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Re-test</span>
            </Button>

            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await signOut();
                router.push('/login');
              }}
              className="text-xs text-[#E0685C] hover:text-white hover:bg-[#B3261E] hover:border-[#B3261E] gap-1 font-semibold"
              title="Log Out of Eagle Eye"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Log Out</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-4xl mx-auto w-full p-4 space-y-6">
        {/* Hardware Capability Matrix */}
        <Card className="bg-[#212C38] border-[#324050] rounded-2xl">
          <CardHeader className="border-b border-[#324050]">
            <CardTitle className="text-base text-[#E9E4D8] flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-[#F0A53A]" />
              <span>Core Mobile Hardware Sensors</span>
            </CardTitle>
          </CardHeader>

          <div className="divide-y divide-slate-800 mt-2">
            {/* Camera */}
            <div className="py-3 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-slate-800 text-[#F0A53A]">
                  <Camera className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-white">Rear Camera (Video / QR / Photo)</div>
                  <div className="text-xs text-slate-400 mt-0.5">{cameraStatus.details}</div>
                </div>
              </div>
              {renderBadge(cameraStatus.status)}
            </div>

            {/* GPS */}
            <div className="py-3 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-slate-800 text-emerald-400">
                  <Navigation className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-white">GPS Geolocation Engine</div>
                  <div className="text-xs text-slate-400 mt-0.5">{gpsStatus.details}</div>
                </div>
              </div>
              {renderBadge(gpsStatus.status)}
            </div>

            {/* Web NFC */}
            <div className="py-3 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-slate-800 text-[#F0A53A]">
                  <Radio className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-white">Web NFC Reader (13.56 MHz NDEF)</div>
                  <div className="text-xs text-slate-400 mt-0.5">{nfcStatus.details}</div>
                </div>
              </div>
              {renderBadge(nfcStatus.status)}
            </div>

            {/* PDF417 SA Licence Disc Engine */}
            <div className="py-3 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-slate-800 text-amber-400">
                  <QrCode className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-white">South African Vehicle Disc Decoder (PDF417)</div>
                  <div className="text-xs text-slate-400 mt-0.5">{pdf417Status.details}</div>
                </div>
              </div>
              {renderBadge(pdf417Status.status)}
            </div>

            {/* IndexedDB */}
            <div className="py-3 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-slate-800 text-[#F0A53A]">
                  <Database className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-white">Offline Storage (IndexedDB / Dexie)</div>
                  <div className="text-xs text-slate-400 mt-0.5">{idbStatus.details}</div>
                </div>
              </div>
              {renderBadge(idbStatus.status)}
            </div>

            {/* Service Worker */}
            <div className="py-3 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-slate-800 text-[#F0A53A]">
                  <RefreshCw className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-white">Service Worker & Offline Cache</div>
                  <div className="text-xs text-slate-400 mt-0.5">{swStatus.details}</div>
                </div>
              </div>
              {renderBadge(swStatus.status)}
            </div>

            {/* Connectivity */}
            <div className="py-3 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-slate-800 text-emerald-400">
                  <Wifi className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-white">Network Connectivity</div>
                  <div className="text-xs text-slate-400 mt-0.5">{networkStatus.details}</div>
                </div>
              </div>
              {renderBadge(networkStatus.status)}
            </div>

            {/* PWA Mode */}
            <div className="py-3 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-slate-800 text-rose-400">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm text-white">PWA Installation Status</div>
                  <div className="text-xs text-slate-400 mt-0.5">{pwaStatus.details}</div>
                </div>
              </div>
              {renderBadge(pwaStatus.status)}
            </div>
          </div>
        </Card>

        {/* Interactive Hardware Diagnostics */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Interactive NFC Tag Test */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Radio className="w-5 h-5 text-[#F0A53A]" />
                <span>Interactive Physical Tag Test</span>
              </CardTitle>
            </CardHeader>

            <p className="text-xs text-slate-400">
              Hold a physical checkpoint tag against the back of your phone to test if your phone&apos;s Web NFC antenna can read it.
            </p>

            <div className="mt-4">
              <Button
                onClick={() => void handleTestNfcTag()}
                disabled={isNfcTesting}
                variant="primary"
                size="md"
                className="w-full gap-2"
              >
                <Radio className={`w-4 h-4 ${isNfcTesting ? 'animate-pulse text-emerald-400' : ''}`} />
                <span>{isNfcTesting ? 'Scanning... Hold Tag to Phone' : 'Test Physical Tag'}</span>
              </Button>
            </div>

            {testedNfcTag?.serial && (
              <div className="mt-4 p-3 rounded-xl bg-emerald-950/80 border border-emerald-800 text-xs">
                <div className="font-bold text-emerald-300">✓ Tag Read Successfully!</div>
                <div className="text-slate-300 mt-1 font-mono">Serial: {testedNfcTag.serial}</div>
                <div className="text-slate-400 mt-0.5">Payload: {testedNfcTag.records}</div>
              </div>
            )}

            {testedNfcTag?.error && (
              <div className="mt-4 p-3 rounded-xl bg-rose-950/80 border border-rose-800 text-xs text-rose-300">
                <div className="font-bold flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-rose-400" />
                  <span>Tag Incompatible with Browser</span>
                </div>
                <p className="mt-1 leading-relaxed">{testedNfcTag.error}</p>
              </div>
            )}
          </Card>

          {/* Audio & Screen Wake Lock Test */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Volume2 className="w-5 h-5 text-amber-400" />
                <span>Audio Synthesizer & Wake Lock</span>
              </CardTitle>
            </CardHeader>

            <p className="text-xs text-slate-400">
              Test the 880Hz audible alert tone and screen keep-awake sentinel used during night guard patrols.
            </p>

            <div className="space-y-3 mt-4">
              <Button
                onClick={handleTestAudio}
                variant="secondary"
                size="md"
                className="w-full gap-2"
              >
                <Volume2 className="w-4 h-4 text-amber-400" />
                <span>{audioPlayed ? 'Play Tone Again (880Hz)' : 'Test Alarm Tone & Vibration'}</span>
              </Button>

              <Button
                onClick={() => void handleToggleWakeLock()}
                variant={wakeLockActive ? 'primary' : 'secondary'}
                size="md"
                className="w-full gap-2"
              >
                <Sun className={`w-4 h-4 ${wakeLockActive ? 'text-amber-300 animate-spin' : ''}`} />
                <span>{wakeLockActive ? 'Screen Wake Lock Active (Tap to Release)' : 'Test Screen Wake Lock'}</span>
              </Button>
            </div>
          </Card>
        </div>

        {/* Hardware Compatibility Guide Notice */}
        <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 flex items-start gap-3">
          <Info className="w-5 h-5 text-[#F0A53A] flex-shrink-0 mt-0.5" />
          <div className="text-xs text-slate-300 space-y-1">
            <div className="font-bold text-white">Technician & Customer Hardware Notice</div>
            <p>
              Security checkpoint tags use either high frequency (13.56 MHz NFC / NDEF) or low frequency (125 kHz RFID / EM4100).
              Standard smartphones with Google Chrome can read 13.56 MHz NFC tags directly. 
              If the customer has 125 kHz buttons or iOS devices, the system automatically uses the high-contrast checkpoint QR cards.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
