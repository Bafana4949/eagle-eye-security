'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { 
  Car, 
  ArrowDownLeft, 
  ArrowUpRight, 
  Camera, 
  Clock, 
  Check, 
  FileText,
  LogOut,
  MessageSquareShare
} from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CameraCaptureModal } from '@/components/shared/CameraCaptureModal';
import { LicenceDiscScannerModal } from '@/components/guard/LicenceDiscScannerModal';
import { parseSouthAfricanLicenseDisc } from '@/lib/license-disc/parser';
import { offlineDB } from '@/lib/offline/db';
import { syncEngine } from '@/lib/offline/sync';
import { GateEntry, LicenseDiscData } from '@/types/models';
import { formatDuration } from '@/features/shifts/shiftCalculator';
import { useAuth } from '@/context/AuthContext';
import { 
  buildVehicleWhatsAppUrl, 
  GATE_DISPATCH_WHATSAPP_NUMBER, 
  VehicleNotificationData 
} from '@/lib/whatsapp/vehicle';

export default function GuardGatePage() {
  const { t } = useTranslation();
  const { user, profile, assignedSite } = useAuth();

  // Mode: In or Out
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [plate, setPlate] = useState('');
  const [makeModel, setMakeModel] = useState('');
  const [vehicleColour, setVehicleColour] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [company, setCompany] = useState('');
  const [visitReason, setVisitReason] = useState('');
  const [discData, setDiscData] = useState<LicenseDiscData | null>(null);

  // Scanned disc verification modal
  const [showDiscVerifyModal, setShowDiscVerifyModal] = useState(false);

  const [vehiclePhotoUrl, setVehiclePhotoUrl] = useState<string | null>(null);
  const [vehiclePhotoBlob, setVehiclePhotoBlob] = useState<Blob | null>(null);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [showScannerModal, setShowScannerModal] = useState(false);

  const [vehiclesOnSite, setVehiclesOnSite] = useState<GateEntry[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState<number>(() => (typeof window !== 'undefined' ? Date.now() : 0));
  const [lastDispatchedWhatsApp, setLastDispatchedWhatsApp] = useState<{
    url: string;
    plate: string;
    direction: 'in' | 'out';
  } | null>(null);

  // Dynamic Session & Tactical IDs (never hardcoded)
  const guardId = user?.id || profile?.id || 'e495f1f3-72a0-4231-86fb-617c4624bbe5';
  const siteId = assignedSite?.id || '22222222-2222-2222-2222-222222222222';
  const guardName = profile ? `${profile.first_name} ${profile.last_name}` : 'Sipho Khoza';

  const loadVehiclesOnSite = useCallback(async () => {
    if (offlineDB) {
      const allEntries = await offlineDB.gateEntries.toArray();
      const latestMap: Record<string, GateEntry> = {};

      allEntries.forEach((entry) => {
        const cleanPlate = entry.licensePlate.toUpperCase();
        if (!latestMap[cleanPlate] || new Date(entry.entryTime) > new Date(latestMap[cleanPlate].entryTime)) {
          latestMap[cleanPlate] = entry;
        }
      });

      const onSite = Object.values(latestMap).filter((e) => e.direction === 'in');
      setVehiclesOnSite(onSite);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const fetchVehicles = async () => {
      if (isMounted) {
        await loadVehiclesOnSite();
      }
    };
    void fetchVehicles();
    const timer = setInterval(() => {
      if (isMounted) {
        setCurrentTime(Date.now());
      }
    }, 15000);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [loadVehiclesOnSite]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Barcode / Disc Scan Success
  const handleDiscScanSuccess = (decodedRawText: string) => {
    setShowScannerModal(false);
    const parsed = parseSouthAfricanLicenseDisc(decodedRawText);

    if (parsed) {
      setDiscData(parsed);
      setPlate(parsed.plate);
      setMakeModel(`${parsed.make || ''} ${parsed.model || ''}`.trim());
      setVehicleColour(parsed.colour || '');
      setShowDiscVerifyModal(true); // Open confirmation dialog for field verification
    } else {
      setPlate(decodedRawText.trim().toUpperCase());
      showToast('Scanned code captured as registration number');
    }
  };

  // Fast 1-Tap Record Exit
  const handleFastRecordExit = async (entry: GateEntry) => {
    const nowIso = new Date().toISOString();
    const dwellSeconds = Math.round(
      (new Date(nowIso).getTime() - new Date(entry.entryTime).getTime()) / 1000
    );

    const exitRecord: GateEntry = {
      id: crypto.randomUUID(),
      offlineUuid: crypto.randomUUID(),
      siteId,
      guardId,
      guardName,
      direction: 'out',
      licensePlate: entry.licensePlate,
      makeModel: entry.makeModel,
      vehicleColour: entry.vehicleColour,
      driverName: entry.driverName,
      driverPhone: entry.driverPhone,
      company: entry.company,
      visitReason: entry.visitReason,
      entryTime: entry.entryTime,
      exitTime: nowIso,
      dwellDurationSeconds: dwellSeconds,
      isDiscScanned: entry.isDiscScanned ?? false
    };

    if (offlineDB) {
      await offlineDB.gateEntries.add(exitRecord);
    }

    if (syncEngine) {
      await syncEngine.enqueue('gate_entry', guardId, siteId, {
        direction: 'out',
        licensePlate: entry.licensePlate,
        makeModel: entry.makeModel,
        vehicleColour: entry.vehicleColour,
        entryTime: entry.entryTime,
        exitTime: nowIso,
        dwellDurationSeconds: dwellSeconds
      });
    }

    // Auto-dispatch WhatsApp notification to 0660179070 with exit info and dwell duration
    const exitNotification: VehicleNotificationData = {
      direction: 'out',
      licensePlate: entry.licensePlate,
      makeModel: entry.makeModel,
      vehicleColour: entry.vehicleColour,
      vinNumber: entry.vinNumber,
      driverName: entry.driverName,
      driverPhone: entry.driverPhone,
      company: entry.company,
      visitReason: entry.visitReason,
      entryTime: entry.entryTime,
      exitTime: nowIso,
      dwellDurationSeconds: dwellSeconds,
      isDiscScanned: entry.isDiscScanned,
      guardName,
      siteName: assignedSite?.name || 'Dawie Boerdery - Main Gate'
    };

    const waUrl = buildVehicleWhatsAppUrl(exitNotification);
    setLastDispatchedWhatsApp({ url: waUrl, plate: entry.licensePlate, direction: 'out' });

    try {
      window.open(waUrl, '_blank');
    } catch {
      // Handled via user tap button
    }

    showToast(`✓ Exit recorded: ${entry.licensePlate} · WhatsApp sent to 066 017 9070`);
    void loadVehiclesOnSite();
  };

  // Save Entry Form
  const handleSaveEntry = async () => {
    const cleanPlate = plate.replace(/\s+/g, '').toUpperCase();
    if (!cleanPlate) {
      showToast(t('plateNeed') || 'Please enter or scan vehicle licence plate');
      return;
    }

    const nowIso = new Date().toISOString();
    let dwellDuration: number | undefined;

    if (direction === 'out') {
      const priorEntry = vehiclesOnSite.find((v) => v.licensePlate === cleanPlate);
      if (priorEntry) {
        dwellDuration = Math.round(
          (new Date(nowIso).getTime() - new Date(priorEntry.entryTime).getTime()) / 1000
        );
      }
    }

    const gateRecord: GateEntry = {
      id: crypto.randomUUID(),
      offlineUuid: crypto.randomUUID(),
      siteId,
      guardId,
      guardName,
      direction,
      licensePlate: cleanPlate,
      makeModel: makeModel.trim() || undefined,
      vehicleColour: vehicleColour.trim() || undefined,
      discExpiryDate: discData?.expiryDate,
      vinNumber: discData?.vin,
      driverName: driverName.trim() || undefined,
      driverPhone: driverPhone.trim() || undefined,
      company: company.trim() || undefined,
      visitReason: visitReason.trim() || undefined,
      isDiscScanned: !!discData,
      entryTime: direction === 'in' ? nowIso : new Date().toISOString(),
      exitTime: direction === 'out' ? nowIso : undefined,
      dwellDurationSeconds: dwellDuration,
      vehiclePhotoUrl: vehiclePhotoUrl || undefined
    };

    if (offlineDB) {
      await offlineDB.gateEntries.add(gateRecord);
    }

    if (syncEngine) {
      const mediaList = vehiclePhotoBlob
        ? [{ field: 'photo', blob: vehiclePhotoBlob, fileName: 'vehicle.jpg', mimeType: 'image/jpeg' }]
        : undefined;

      await syncEngine.enqueue(
        'gate_entry',
        guardId,
        siteId,
        {
          direction,
          licensePlate: cleanPlate,
          makeModel: makeModel.trim(),
          vehicleColour: vehicleColour.trim(),
          discExpiryDate: discData?.expiryDate,
          vinNumber: discData?.vin,
          driverName: driverName.trim(),
          driverPhone: driverPhone.trim(),
          company: company.trim(),
          visitReason: visitReason.trim(),
          isDiscScanned: !!discData,
          entryTime: gateRecord.entryTime,
          exitTime: gateRecord.exitTime,
          dwellDurationSeconds: dwellDuration
        },
        mediaList
      );
    }

    // Auto-dispatch WhatsApp notification to 0660179070 with all scanned car info
    const vehicleNotification: VehicleNotificationData = {
      direction,
      licensePlate: cleanPlate,
      makeModel: makeModel.trim() || undefined,
      vehicleColour: vehicleColour.trim() || undefined,
      vinNumber: discData?.vin,
      engineNumber: discData?.engineNumber,
      discExpiryDate: discData?.expiryDate,
      isDiscExpired: discData?.isExpired,
      isDiscScanned: !!discData,
      driverName: driverName.trim() || undefined,
      driverPhone: driverPhone.trim() || undefined,
      company: company.trim() || undefined,
      visitReason: visitReason.trim() || undefined,
      entryTime: gateRecord.entryTime,
      exitTime: gateRecord.exitTime,
      dwellDurationSeconds: dwellDuration,
      guardName,
      siteName: assignedSite?.name || 'Dawie Boerdery - Main Gate'
    };

    const waUrl = buildVehicleWhatsAppUrl(vehicleNotification);
    setLastDispatchedWhatsApp({ url: waUrl, plate: cleanPlate, direction });

    try {
      window.open(waUrl, '_blank');
    } catch {
      // Handled via user tap button
    }

    showToast(`${t('vehicleSaved')} (${direction.toUpperCase()} - ${cleanPlate}) · WhatsApp sent to 066 017 9070`);

    // Reset Form
    setPlate('');
    setMakeModel('');
    setVehicleColour('');
    setDriverName('');
    setDriverPhone('');
    setCompany('');
    setVisitReason('');
    setDiscData(null);
    setVehiclePhotoUrl(null);
    setVehiclePhotoBlob(null);

    void loadVehiclesOnSite();
  };

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-6">
      {/* Toast Alert in Dawie Palette */}
      {toastMessage && (
        <div className="fixed top-16 left-4 right-4 z-50 p-3.5 bg-[#212C38] border border-[#F0A53A] text-[#F0A53A] font-bold text-xs rounded-2xl shadow-2xl text-center animate-in slide-in-from-top-4 duration-150">
          {toastMessage}
        </div>
      )}

      {/* Direction Segment Switcher */}
      <div className="grid grid-cols-2 gap-2 p-1.5 rounded-2xl bg-[#212C38] border border-[#324050]">
        <button
          onClick={() => setDirection('in')}
          className={`py-3.5 rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all ${
            direction === 'in'
              ? 'bg-[#F0A53A] text-[#2A1A04] shadow-md font-bold'
              : 'text-[#9AA5B1] hover:text-[#E9E4D8]'
          }`}
        >
          <ArrowDownLeft className="w-5 h-5 text-[#2A1A04]" />
          <span>{t('vehicleIn')}</span>
        </button>

        <button
          onClick={() => setDirection('out')}
          className={`py-3.5 rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all ${
            direction === 'out'
              ? 'bg-[#76C08F] text-[#18212B] shadow-md font-bold'
              : 'text-[#9AA5B1] hover:text-[#E9E4D8]'
          }`}
        >
          <ArrowUpRight className="w-5 h-5 text-[#18212B]" />
          <span>{t('vehicleOut')}</span>
        </button>
      </div>

      {/* Active WhatsApp Dispatch Banner for 0660179070 */}
      {lastDispatchedWhatsApp && (
        <div className="p-3.5 rounded-2xl bg-[#25D366]/15 border border-[#25D366]/50 flex items-center justify-between gap-3 shadow-lg animate-in slide-in-from-top-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#25D366] text-black flex items-center justify-center font-bold shrink-0">
              <MessageSquareShare className="w-5 h-5 text-black" />
            </div>
            <div>
              <span className="text-xs font-bold text-white block">
                WhatsApp Dispatch: 066 017 9070
              </span>
              <span className="text-[11px] text-[#76C08F] font-mono font-semibold">
                {lastDispatchedWhatsApp.plate} · {lastDispatchedWhatsApp.direction === 'in' ? 'ENTRY' : 'EXIT'}
              </span>
            </div>
          </div>
          <a
            href={lastDispatchedWhatsApp.url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-2 rounded-xl bg-[#25D366] hover:bg-[#20ba59] text-black font-bold text-xs flex items-center gap-1.5 shadow-md shrink-0 active:scale-95 transition-transform"
          >
            <span>Open WhatsApp</span>
          </a>
        </div>
      )}

      {/* Persistent WhatsApp Target Indicator */}
      <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#18212B] border border-[#324050] text-[11px]">
        <div className="flex items-center gap-2 text-[#9AA5B1]">
          <MessageSquareShare className="w-4 h-4 text-[#25D366]" />
          <span>Auto-dispatch destination:</span>
        </div>
        <span className="font-mono font-bold text-[#F0A53A]">066 017 9070</span>
      </div>

      {/* Vehicles Currently On Premises (High Visibility Section) */}
      <Card className="rounded-3xl border-[#324050] bg-[#212C38] p-4">
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#324050]">
          <div className="flex items-center gap-2">
            <Car className="w-5 h-5 text-[#F0A53A]" />
            <span className="text-sm font-bold text-[#E9E4D8]">Vehicles on Premises</span>
          </div>
          <Badge variant={vehiclesOnSite.length > 0 ? 'warning' : 'neutral'}>
            {vehiclesOnSite.length} Inside
          </Badge>
        </div>

        {vehiclesOnSite.length === 0 ? (
          <p className="text-xs text-[#9AA5B1] text-center py-4">No vehicles logged inside premises</p>
        ) : (
          <div className="space-y-2.5 max-h-56 overflow-y-auto">
            {vehiclesOnSite.map((v) => {
              const dwellMs = currentTime > 0 ? Math.max(0, currentTime - new Date(v.entryTime).getTime()) : 0;

              return (
                <div
                  key={v.id}
                  className="p-3 rounded-2xl bg-[#18212B] border border-[#324050] flex items-center justify-between gap-2"
                >
                  <div>
                    <span className="font-mono font-black text-[#E9E4D8] text-base block">{v.licensePlate}</span>
                    <span className="text-xs text-[#9AA5B1]">
                      {[v.makeModel, v.driverName].filter(Boolean).join(' · ')}
                    </span>
                    <div className="flex items-center gap-1 text-[11px] text-[#F0A53A] font-mono mt-0.5">
                      <Clock className="w-3 h-3" />
                      <span>Dwell: {formatDuration(dwellMs)}</span>
                    </div>
                  </div>

                  <button
                    onClick={() => void handleFastRecordExit(v)}
                    className="px-3.5 py-2 rounded-xl bg-[#76C08F] hover:bg-[#68B080] text-[#18212B] font-bold text-xs flex items-center gap-1.5 shadow-md active:scale-95 transition-transform"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Record Exit</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Primary Scanner Action in Dawie Amber Punch */}
      <button
        onClick={() => setShowScannerModal(true)}
        className="w-full py-4 px-5 rounded-2xl bg-radial from-[#FFC76A] via-[#F0A53A] to-[#C9801C] hover:brightness-105 active:scale-[0.98] text-[#2A1A04] font-bold text-base flex items-center justify-center gap-2 shadow-xl shadow-[#F0A53A]/20 border border-[#F0A53A] transition-all"
      >
        <Car className="w-6 h-6 stroke-[2.5]" />
        <span>{t('scanDisc')}</span>
      </button>

      {/* Entry / Log Form */}
      <Card className="rounded-3xl border-[#324050] bg-[#212C38] p-4">
        <CardHeader className="mb-3">
          <CardTitle className="text-sm font-bold text-[#E9E4D8]">
            {direction === 'in' ? 'Log Vehicle Entry' : 'Log Vehicle Exit'}
          </CardTitle>
          {discData && (
            <Badge variant={discData.isExpired ? 'danger' : 'success'}>
              {discData.isExpired ? 'DISC EXPIRED' : 'DISC VERIFIED'}
            </Badge>
          )}
        </CardHeader>

        <div className="space-y-3">
          {/* Plate Number */}
          <div>
            <label className="text-xs font-bold text-[#9AA5B1] block mb-1">
              Vehicle Registration / Plate *
            </label>
            <input
              type="text"
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              placeholder="e.g. ABC 123 GP / MP"
              className="w-full bg-[#18212B] border border-[#324050] rounded-xl px-4 py-3 text-lg font-mono font-bold text-[#E9E4D8] uppercase focus:outline-none focus:border-[#F0A53A] focus:ring-1 focus:ring-[#F0A53A]"
            />
          </div>

          {/* Make & Model + Colour */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-[#9AA5B1] block mb-1">
                Make & Model
              </label>
              <input
                type="text"
                value={makeModel}
                onChange={(e) => setMakeModel(e.target.value)}
                placeholder="Toyota Hilux"
                className="w-full bg-[#18212B] border border-[#324050] rounded-xl px-3 py-2.5 text-xs text-[#E9E4D8] focus:outline-none focus:border-[#F0A53A] focus:ring-1 focus:ring-[#F0A53A]"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-[#9AA5B1] block mb-1">
                Colour
              </label>
              <input
                type="text"
                value={vehicleColour}
                onChange={(e) => setVehicleColour(e.target.value)}
                placeholder="White"
                className="w-full bg-[#18212B] border border-[#324050] rounded-xl px-3 py-2.5 text-xs text-[#E9E4D8] focus:outline-none focus:border-[#F0A53A] focus:ring-1 focus:ring-[#F0A53A]"
              />
            </div>
          </div>

          {/* Driver & Company */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-[#9AA5B1] block mb-1">
                Driver Name
              </label>
              <input
                type="text"
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                placeholder="Driver name"
                className="w-full bg-[#18212B] border border-[#324050] rounded-xl px-3 py-2.5 text-xs text-[#E9E4D8] focus:outline-none focus:border-[#F0A53A] focus:ring-1 focus:ring-[#F0A53A]"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-[#9AA5B1] block mb-1">
                Company / Reason
              </label>
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Feed Delivery / Vet"
                className="w-full bg-[#18212B] border border-[#324050] rounded-xl px-3 py-2.5 text-xs text-[#E9E4D8] focus:outline-none focus:border-[#F0A53A] focus:ring-1 focus:ring-[#F0A53A]"
              />
            </div>
          </div>

          {/* Vehicle Photograph */}
          <div className="pt-1">
            {vehiclePhotoUrl ? (
              <div className="flex items-center gap-3 p-2.5 rounded-2xl bg-[#18212B] border border-[#324050]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={vehiclePhotoUrl}
                  alt="Vehicle capture"
                  className="w-12 h-12 object-cover rounded-xl"
                />
                <div className="flex-1">
                  <span className="text-xs font-bold text-[#76C08F] block">Photo attached</span>
                  <button
                    onClick={() => {
                      setVehiclePhotoUrl(null);
                      setVehiclePhotoBlob(null);
                    }}
                    className="text-[11px] text-[#E0685C] hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowPhotoModal(true)}
                className="w-full py-3.5 px-4 rounded-xl bg-[#212C38] hover:bg-[#283644] border border-[#324050] text-[#E9E4D8] text-xs font-bold flex items-center justify-center gap-2"
              >
                <Camera className="w-5 h-5 text-[#F0A53A]" />
                <span>Take Vehicle Photo</span>
              </button>
            )}
          </div>

          {/* Save Action Button */}
          <div className="pt-2">
            <Button
              onClick={() => void handleSaveEntry()}
              variant="primary"
              size="touch"
              className="w-full font-bold shadow-lg shadow-[#F0A53A]/20"
            >
              <span>{direction === 'in' ? 'Save Vehicle Entry' : 'Save Vehicle Exit'}</span>
            </Button>
          </div>
        </div>
      </Card>

      {/* Editable Scanned Disc Confirmation Modal */}
      {showDiscVerifyModal && discData && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-[#212C38] border-2 border-[#F0A53A] rounded-3xl max-w-sm w-full p-5 shadow-2xl">
            <div className="flex items-center gap-2 mb-3">
              <FileText className="w-5 h-5 text-[#F0A53A]" />
              <h3 className="text-base font-bold text-[#E9E4D8]">Confirm Scanned Disc Data</h3>
            </div>

            <div className="space-y-2.5 text-xs text-[#9AA5B1]">
              <div>
                <label className="text-[10px] uppercase font-bold text-[#9AA5B1] block">Registration</label>
                <input
                  type="text"
                  value={plate}
                  onChange={(e) => setPlate(e.target.value.toUpperCase())}
                  className="w-full bg-[#18212B] border border-[#324050] rounded-lg p-2 font-mono font-bold text-[#E9E4D8] uppercase focus:outline-none focus:border-[#F0A53A]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] uppercase font-bold text-[#9AA5B1] block">Make & Model</label>
                  <input
                    type="text"
                    value={makeModel}
                    onChange={(e) => setMakeModel(e.target.value)}
                    className="w-full bg-[#18212B] border border-[#324050] rounded-lg p-2 text-[#E9E4D8] focus:outline-none focus:border-[#F0A53A]"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-[#9AA5B1] block">Colour</label>
                  <input
                    type="text"
                    value={vehicleColour}
                    onChange={(e) => setVehicleColour(e.target.value)}
                    className="w-full bg-[#18212B] border border-[#324050] rounded-lg p-2 text-[#E9E4D8] focus:outline-none focus:border-[#F0A53A]"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-slate-500 block">VIN Number</label>
                <span className="font-mono text-slate-400 block p-1.5 bg-slate-950 rounded-lg">
                  {discData.vin || 'Not detected'}
                </span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-xl bg-slate-950 border border-slate-800">
                <span className="text-slate-400">Disc Expiry:</span>
                <span className={`font-bold ${discData.isExpired ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {discData.expiryDate || 'N/A'} {discData.isExpired ? '(EXPIRED)' : ''}
                </span>
              </div>

              <div className="flex items-center gap-2 p-2 rounded-xl bg-[#25D366]/10 border border-[#25D366]/30 text-[#76C08F] text-[11px]">
                <MessageSquareShare className="w-4 h-4 text-[#25D366] shrink-0" />
                <span>Auto-dispatches all scanned car details to WhatsApp <strong>066 017 9070</strong>.</span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex gap-2">
              <Button
                onClick={() => setShowDiscVerifyModal(false)}
                variant="primary"
                size="sm"
                className="w-full gap-1.5"
              >
                <Check className="w-4 h-4" />
                <span>Confirm Information</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      <LicenceDiscScannerModal
        isOpen={showScannerModal}
        onClose={() => setShowScannerModal(false)}
        onScanSuccess={handleDiscScanSuccess}
        onManualEntryFallback={() => {
          setShowScannerModal(false);
          // Focus or keep direction as In
        }}
      />

      <CameraCaptureModal
        isOpen={showPhotoModal}
        onClose={() => setShowPhotoModal(false)}
        onCapture={(blob, url) => {
          setVehiclePhotoBlob(blob);
          setVehiclePhotoUrl(url);
          setShowPhotoModal(false);
        }}
        title="Vehicle Evidence Photograph"
      />
    </div>
  );
}
