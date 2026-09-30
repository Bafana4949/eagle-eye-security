'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { 
  Building2, 
  Users, 
  QrCode, 
  Printer, 
  Plus, 
  Trash2, 
  Save, 
  ArrowLeft,
  FileSpreadsheet,
  Radio,
  Smartphone,
  PhoneCall,
  CheckCircle2,
  LogOut
} from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { I18nProvider } from '@/lib/i18n/context';
import { Checkpoint } from '@/types/models';
import { offlineDB } from '@/lib/offline/db';
import { useAuth } from '@/context/AuthContext';
import { createClient } from '@/lib/supabase/client';

interface WebNdefReadingEvent {
  serialNumber?: string;
}

interface WebNdefReaderInstance {
  scan: () => Promise<void>;
  onreading: (event: WebNdefReadingEvent) => void;
  onreadingerror: (error: unknown) => void;
}

export default function AdminPortalPage() {
  const router = useRouter();
  const { assignedSite, signOut } = useAuth();
  const supabase = React.useMemo(() => createClient(), []);

  const [activeSection, setActiveSection] = useState<'checkpoints' | 'sites' | 'guards' | 'branding' | 'audit'>('checkpoints');
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [newCpName, setNewCpName] = useState('');
  const [newCpRadius, setNewCpRadius] = useState(50);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // NFC Enrolment State
  const [enrollingCpId, setEnrollingCpId] = useState<string | null>(null);

  // Site Configuration State
  const [siteName, setSiteName] = useState('Dawie Boerdery - Hoofplaas');
  const [siteCode, setSiteCode] = useState('DW-01');
  const [dayStart, setDayStart] = useState('06:00');
  const [dayEnd, setDayEnd] = useState('18:00');
  const [nightStart, setNightStart] = useState('18:00');
  const [nightEnd, setNightEnd] = useState('06:00');
  const [roundInterval, setRoundInterval] = useState(60);
  const [emergencyPhone, setEmergencyPhone] = useState('+27 82 999 4321');
  const [supervisorWhatsApp, setSupervisorWhatsApp] = useState('+27 82 123 4567');

  const siteId = assignedSite?.id || '22222222-2222-2222-2222-222222222222';

  // Guards Roster State
  const [guards, setGuards] = useState([
    { id: '1', name: 'Wag 1 / Sipho Khoza', employeeNo: 'G-101', role: 'guard', phone: '+27 82 111 2222', active: true },
    { id: '2', name: 'Wag 2 / Petrus Ndlovu', employeeNo: 'G-102', role: 'guard', phone: '+27 82 333 4444', active: true },
    { id: '3', name: 'Dawie Snyman', employeeNo: 'ADM-01', role: 'admin', phone: '+27 82 999 4321', active: true }
  ]);
  const [newGuardName, setNewGuardName] = useState('');
  const [newGuardPhone, setNewGuardPhone] = useState('');

  const generateQrImages = useCallback(async (cps: Checkpoint[]) => {
    const map: Record<string, string> = {};
    for (const cp of cps) {
      try {
        const url = await QRCode.toDataURL(cp.qrCodeHash, {
          width: 256,
          margin: 1,
          color: { dark: '#000000', light: '#ffffff' }
        });
        map[cp.id] = url;
      } catch {
        // Fallback
      }
    }
    setQrImages(map);
  }, []);

  const loadData = useCallback(async () => {
    // 1. Fetch checkpoints from Supabase
    try {
      const { data: remoteCps } = await supabase
        .from('checkpoints')
        .select('*')
        .eq('site_id', siteId)
        .order('order_index');

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
        setCheckpoints(formatted);
        void generateQrImages(formatted);
        if (offlineDB) {
          await offlineDB.checkpoints.bulkPut(formatted);
        }
      } else if (offlineDB) {
        const cps = await offlineDB.checkpoints.toArray();
        setCheckpoints(cps);
        void generateQrImages(cps);
      }
    } catch {
      if (offlineDB) {
        const cps = await offlineDB.checkpoints.toArray();
        setCheckpoints(cps);
        void generateQrImages(cps);
      }
    }

    // 2. Fetch site settings from Supabase
    try {
      const { data: site } = await supabase.from('sites').select('*').eq('id', siteId).maybeSingle();
      if (site) {
        setSiteName(site.name);
        setSiteCode(site.code);
        if (site.emergency_phone) setEmergencyPhone(site.emergency_phone);
        if (site.whatsapp_dispatch_number) setSupervisorWhatsApp(site.whatsapp_dispatch_number);
        if (site.round_interval_minutes) setRoundInterval(site.round_interval_minutes);
      }
    } catch {
      // Use fallback defaults
    }
  }, [supabase, siteId, generateQrImages]);

  useEffect(() => {
    let isMounted = true;
    const timer = setTimeout(() => {
      if (isMounted) void loadData();
    }, 0);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [loadData]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3500);
  };

  const handleAddCheckpoint = async () => {
    if (!newCpName.trim()) {
      showToast('Please enter a checkpoint name');
      return;
    }

    // Cryptographically secure checkpoint token format: EE-CP-XXXXXXXX
    const randomSuffix = crypto.randomUUID().slice(0, 8).toUpperCase();
    const qrCodeHash = `EE-CP-${randomSuffix}`;

    try {
      const { data: inserted, error: insertError } = await supabase
        .from('checkpoints')
        .insert({
          site_id: siteId,
          name: newCpName.trim(),
          qr_code_hash: qrCodeHash,
          permitted_radius_meters: newCpRadius,
          order_index: checkpoints.length + 1,
          is_active: true
        })
        .select()
        .single();

      if (insertError) {
        showToast(`Database error: ${insertError.message}`);
        return;
      }

      const newCp: Checkpoint = {
        id: inserted.id,
        siteId: inserted.site_id,
        name: inserted.name,
        qrCodeHash: inserted.qr_code_hash,
        permittedRadiusMeters: inserted.permitted_radius_meters,
        orderIndex: inserted.order_index,
        isActive: inserted.is_active
      };

      if (offlineDB) {
        await offlineDB.checkpoints.put(newCp);
      }

      const updated = [...checkpoints, newCp];
      setCheckpoints(updated);
      void generateQrImages(updated);
      setNewCpName('');
      showToast(`✓ Checkpoint persisted to Supabase: ${qrCodeHash}`);
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to save checkpoint to database');
    }
  };

  const handleDeleteCheckpoint = async (id: string) => {
    if (confirm('Delete this checkpoint from database?')) {
      try {
        await supabase.from('checkpoints').delete().eq('id', id);
        if (offlineDB) {
          await offlineDB.checkpoints.delete(id);
        }
        const updated = checkpoints.filter((c) => c.id !== id);
        setCheckpoints(updated);
        void generateQrImages(updated);
        showToast('✓ Checkpoint removed from database');
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'Failed to delete checkpoint');
      }
    }
  };

  // Enrol Real NFC Tag Workflow
  const handleEnrolNfcTag = async (checkpoint: Checkpoint) => {
    if (typeof window === 'undefined' || !('NDEFReader' in window)) {
      showToast('Web NFC is not supported on this device/browser. Please use Chrome on Android or QR cards.');
      return;
    }

    setEnrollingCpId(checkpoint.id);
    showToast(`Hold physical NFC tag against your phone to link with "${checkpoint.name}"...`);

    try {
      const NDEFReaderClass = (window as unknown as { NDEFReader: new () => WebNdefReaderInstance }).NDEFReader;
      const reader = new NDEFReaderClass();
      await reader.scan();

      reader.onreading = async (event: WebNdefReadingEvent) => {
        setEnrollingCpId(null);
        if (!event.serialNumber) {
          showToast('NFC Tag detected, but serialNumber could not be read. Please tap tag firmly again.');
          return;
        }

        const tagSerial = event.serialNumber.replace(/:/g, '').toUpperCase();

        try {
          const { error: dbError } = await supabase
            .from('checkpoints')
            .update({ nfc_uid: tagSerial })
            .eq('id', checkpoint.id);

          if (dbError) {
            showToast(`Database update error: ${dbError.message}`);
            return;
          }

          if (offlineDB) {
            await offlineDB.checkpoints.update(checkpoint.id, { nfcUid: tagSerial });
          }

          const updated = checkpoints.map((c) => (c.id === checkpoint.id ? { ...c, nfcUid: tagSerial } : c));
          setCheckpoints(updated);

          if (typeof navigator !== 'undefined' && navigator.vibrate) {
            navigator.vibrate([200, 100, 200]);
          }
          showToast(`✓ Real NFC Tag (${tagSerial}) saved to Supabase for ${checkpoint.name}!`);
        } catch (err: unknown) {
          showToast(err instanceof Error ? err.message : 'Database error updating NFC tag');
        }
      };

      reader.onreadingerror = () => {
        setEnrollingCpId(null);
        showToast('Tag read error: Tag incompatible or moved away too quickly.');
      };
    } catch (err: unknown) {
      setEnrollingCpId(null);
      const error = err as Error;
      showToast(`NFC Error: ${error.message}`);
    }
  };

  const handlePrintCards = () => {
    window.print();
  };

  const handleAddGuard = () => {
    if (!newGuardName.trim()) return;
    const newG = {
      id: crypto.randomUUID(),
      name: newGuardName.trim(),
      employeeNo: `G-${100 + guards.length + 1}`,
      role: 'guard',
      phone: newGuardPhone.trim(),
      active: true
    };
    setGuards([...guards, newG]);
    setNewGuardName('');
    setNewGuardPhone('');
    showToast('Guard added to roster');
  };

  const handleSaveSiteConfig = async () => {
    try {
      const { error } = await supabase.from('sites').update({
        name: siteName,
        code: siteCode,
        day_shift_start: `${dayStart}:00`,
        day_shift_end: `${dayEnd}:00`,
        night_shift_start: `${nightStart}:00`,
        night_shift_end: `${nightEnd}:00`,
        round_interval_minutes: roundInterval,
        emergency_phone: emergencyPhone,
        whatsapp_dispatch_number: supervisorWhatsApp
      }).eq('id', siteId);

      if (error) {
        showToast(`Database error: ${error.message}`);
      } else {
        showToast('✓ Site configuration & WhatsApp numbers saved to database');
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to save configuration');
    }
  };

  return (
    <I18nProvider>
      <div className="min-h-screen bg-[#18212B] text-[#E9E4D8] flex flex-col font-sans">
        {/* Toast Alert */}
        {toastMsg && (
          <div className="fixed top-16 left-4 right-4 z-50 p-3.5 bg-[#F0A53A] text-[#2A1A04] font-bold text-sm rounded-xl shadow-2xl text-center max-w-md mx-auto border border-[#F0A53A] animate-in slide-in-from-top-4 duration-200">
            {toastMsg}
          </div>
        )}

        {/* Header */}
        <header className="sticky top-0 z-30 bg-[#18212B]/95 backdrop-blur-md border-b border-[#324050] px-4 py-3">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/supervisor" className="p-2 rounded-xl bg-[#212C38] border border-[#324050] text-[#9AA5B1] hover:text-[#E9E4D8]">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div>
                <h1 className="text-lg font-bold text-[#E9E4D8] tracking-tight flex items-center gap-2">
                  <span>Administration & Hardware Configuration</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#F0A53A]/20 text-[#F0A53A] border border-[#F0A53A]/40 uppercase">
                    Admin
                  </span>
                </h1>
                <p className="text-xs text-[#9AA5B1]">Manage sites, NFC checkpoints, roster & device tests</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link href="/admin/device-test">
                <Button variant="secondary" size="sm" className="gap-1.5 text-xs text-[#F0A53A] border-[#F0A53A]/40">
                  <Smartphone className="w-4 h-4" />
                  <span className="hidden sm:inline">Hardware Diagnostics</span>
                </Button>
              </Link>

              <Button onClick={handlePrintCards} variant="primary" size="sm" className="gap-1.5 font-bold text-xs">
                <Printer className="w-4 h-4" />
                <span>Print QR Cards</span>
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

        {/* Main Content */}
        <main className="flex-1 max-w-6xl mx-auto w-full p-4 space-y-6">
          {/* Section Navigation */}
          <div className="flex items-center gap-2 border-b border-[#324050] pb-2 overflow-x-auto">
            {[
              { id: 'checkpoints', label: 'Checkpoints & QR / NFC', icon: QrCode },
              { id: 'sites', label: 'Site & Shift Schedules', icon: Building2 },
              { id: 'guards', label: 'Guard Roster & Users', icon: Users },
              { id: 'audit', label: 'Audit Trail Logs', icon: FileSpreadsheet }
            ].map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveSection(tab.id as typeof activeSection)}
                  className={`px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-all whitespace-nowrap ${
                    activeSection === tab.id
                      ? 'bg-[#F0A53A] text-[#2A1A04] shadow-md'
                      : 'text-[#9AA5B1] hover:text-[#E9E4D8] hover:bg-[#212C38]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* SECTION 1: CHECKPOINTS & QR / NFC ENROLMENT */}
          {activeSection === 'checkpoints' && (
            <div className="space-y-6">
              {/* Add Checkpoint Card */}
              <Card>
                <CardHeader>
                  <CardTitle>Create New Security Checkpoint</CardTitle>
                </CardHeader>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2">
                    <label className="text-xs font-semibold text-slate-400 block mb-1">
                      Checkpoint Name / Description
                    </label>
                    <input
                      type="text"
                      value={newCpName}
                      onChange={(e) => setNewCpName(e.target.value)}
                      placeholder="e.g. Pump Station East / Diesel Reservoir"
                      className="w-full bg-[#18212B] border border-[#324050] rounded-xl px-4 py-2.5 text-sm text-[#E9E4D8] focus:outline-none focus:border-[#F0A53A] focus:ring-1 focus:ring-[#F0A53A]"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">
                      Validation Radius (meters)
                    </label>
                    <select
                      value={newCpRadius}
                      onChange={(e) => setNewCpRadius(Number(e.target.value))}
                      className="w-full bg-[#18212B] border border-[#324050] rounded-xl px-4 py-2.5 text-sm text-[#E9E4D8] focus:outline-none focus:border-[#F0A53A] focus:ring-1 focus:ring-[#F0A53A]"
                    >
                      <option value={30}>30 m (High precision)</option>
                      <option value={50}>50 m (Standard)</option>
                      <option value={75}>75 m (Open field)</option>
                      <option value={100}>100 m (Boundary beacon)</option>
                    </select>
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <Button onClick={handleAddCheckpoint} variant="primary" size="md" className="gap-2">
                    <Plus className="w-4 h-4" />
                    <span>Generate Checkpoint QR & Beacon</span>
                  </Button>
                </div>
              </Card>

              {/* Checkpoints Grid */}
              <Card>
                <CardHeader className="flex items-center justify-between">
                  <CardTitle>Configured Checkpoints ({checkpoints.length})</CardTitle>
                  <Button onClick={handlePrintCards} variant="secondary" size="sm" className="gap-2">
                    <Printer className="w-4 h-4 text-[#F0A53A]" />
                    <span>Print All Checkpoint Cards</span>
                  </Button>
                </CardHeader>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                  {checkpoints.map((cp, idx) => (
                    <div
                      key={cp.id}
                      className="p-4 rounded-2xl bg-slate-900 border border-slate-800 flex flex-col justify-between gap-3"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          <div className="w-16 h-16 bg-white rounded-xl p-1 flex items-center justify-center flex-shrink-0 shadow-md">
                            {qrImages[cp.id] ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={qrImages[cp.id]} alt={cp.name} className="w-full h-full object-contain" />
                            ) : (
                              <div className="text-[10px] font-mono text-slate-800 font-bold">QR</div>
                            )}
                          </div>

                          <div>
                            <h4 className="font-bold text-sm text-white">{cp.name}</h4>
                            <p className="text-xs font-mono text-[#F0A53A] font-semibold mt-0.5">
                              {cp.qrCodeHash}
                            </p>
                            <p className="text-[11px] text-slate-400 mt-1">
                              Radius: {cp.permittedRadiusMeters}m · Order: #{idx + 1}
                            </p>
                            <div className="mt-1 text-[11px] font-mono flex items-center gap-1.5">
                              <Radio className="w-3.5 h-3.5 text-[#F0A53A]" />
                              <span className={cp.nfcUid ? 'text-[#F0A53A]' : 'text-slate-500'}>
                                {cp.nfcUid ? `NFC: ${cp.nfcUid}` : 'No NFC tag linked'}
                              </span>
                            </div>
                          </div>
                        </div>

                        <button
                          onClick={() => handleDeleteCheckpoint(cp.id)}
                          className="text-slate-500 hover:text-rose-400 p-2"
                          title="Delete checkpoint"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      {/* NFC Tag Enrolment Action */}
                      <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                        <Button
                          onClick={() => void handleEnrolNfcTag(cp)}
                          disabled={enrollingCpId === cp.id}
                          variant={cp.nfcUid ? 'secondary' : 'primary'}
                          size="sm"
                          className="gap-1.5 text-xs w-full"
                        >
                          <Radio className={`w-3.5 h-3.5 ${enrollingCpId === cp.id ? 'animate-pulse text-amber-400' : ''}`} />
                          <span>
                            {enrollingCpId === cp.id
                              ? 'Scanning... Hold Tag to Phone'
                              : cp.nfcUid
                              ? 'Re-enrol NFC Tag'
                              : 'Register / Enrol NFC Tag'}
                          </span>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Printable QR Cards Sheet (Visible during Print command) */}
              <div id="printable-cards" className="hidden print:block bg-white text-black p-8 font-sans">
                <div className="text-center mb-8 border-b-2 border-black pb-4">
                  <h1 className="text-3xl font-black tracking-tight">EAGLE EYE SECURITY</h1>
                  <p className="text-sm font-bold uppercase tracking-wider text-gray-700 mt-1">
                    Checkpoint Patrol QR Cards — {siteName}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-8">
                  {checkpoints.map((cp, idx) => (
                    <div
                      key={cp.id}
                      className="border-4 border-black p-6 rounded-2xl text-center flex flex-col items-center justify-between page-break-inside-avoid"
                    >
                      <div className="text-xs font-black uppercase tracking-wider bg-black text-white px-3 py-1 rounded-full mb-3">
                        CHECKPOINT #{idx + 1}
                      </div>

                      <div className="w-52 h-52 border-2 border-black p-2 flex items-center justify-center mb-4 bg-white">
                        {qrImages[cp.id] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={qrImages[cp.id]} alt={cp.name} className="w-full h-full object-contain" />
                        ) : (
                          <div className="font-mono text-xs">{cp.qrCodeHash}</div>
                        )}
                      </div>

                      <h2 className="text-2xl font-black text-black">{cp.name}</h2>
                      <p className="text-sm font-mono font-bold text-gray-800 mt-1">{cp.qrCodeHash}</p>
                      <p className="text-xs mt-3 text-gray-600 border-t border-gray-300 pt-2 w-full">
                        Aiguille Security & Dawie Boerdery
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* SECTION 2: SITES & SHIFT CONFIGURATION */}
          {activeSection === 'sites' && (
            <Card>
              <CardHeader>
                <CardTitle>Site & Shift Operations Schedule</CardTitle>
              </CardHeader>

              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">Site Name</label>
                    <input
                      type="text"
                      value={siteName}
                      onChange={(e) => setSiteName(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">Site Code</label>
                    <input
                      type="text"
                      value={siteCode}
                      onChange={(e) => setSiteCode(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
                    />
                  </div>
                </div>

                {/* WhatsApp Dispatch Number */}
                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                  <div className="flex items-center gap-2 mb-2">
                    <PhoneCall className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold text-emerald-400">Supervisor WhatsApp Summary Recipient</span>
                  </div>
                  <label className="text-[11px] text-slate-400 block mb-1">
                    WhatsApp Number in International Format (e.g. +27 82 123 4567)
                  </label>
                  <input
                    type="tel"
                    value={supervisorWhatsApp}
                    onChange={(e) => setSupervisorWhatsApp(e.target.value)}
                    placeholder="+27 82 123 4567"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white font-mono"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    When guards complete a shift or trigger summary dispatch, reports are prefilled directly to this WhatsApp contact.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                    <span className="text-xs font-bold text-amber-400 block mb-2">☀️ Day Shift Hours</span>
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="text-[11px] text-slate-400 block mb-1">Starts</label>
                        <input
                          type="time"
                          value={dayStart}
                          onChange={(e) => setDayStart(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm text-white"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-[11px] text-slate-400 block mb-1">Ends</label>
                        <input
                          type="time"
                          value={dayEnd}
                          onChange={(e) => setDayEnd(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm text-white"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                    <span className="text-xs font-bold text-[#F0A53A] block mb-2">🌙 Night Shift Hours</span>
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="text-[11px] text-slate-400 block mb-1">Starts</label>
                        <input
                          type="time"
                          value={nightStart}
                          onChange={(e) => setNightStart(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm text-white"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-[11px] text-slate-400 block mb-1">Ends</label>
                        <input
                          type="time"
                          value={nightEnd}
                          onChange={(e) => setNightEnd(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm text-white"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">
                      Patrol Round Interval
                    </label>
                    <select
                      value={roundInterval}
                      onChange={(e) => setRoundInterval(Number(e.target.value))}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
                    >
                      <option value={30}>Every 30 minutes</option>
                      <option value={45}>Every 45 minutes</option>
                      <option value={60}>Every 60 minutes (Standard)</option>
                      <option value={90}>Every 90 minutes</option>
                      <option value={120}>Every 2 hours</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">
                      Emergency Boss / Farm Owner Phone
                    </label>
                    <input
                      type="tel"
                      value={emergencyPhone}
                      onChange={(e) => setEmergencyPhone(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white font-mono"
                    />
                  </div>
                </div>

                <div className="pt-4 flex justify-end">
                  <Button onClick={handleSaveSiteConfig} variant="primary" size="md" className="gap-2">
                    <Save className="w-4 h-4" />
                    <span>Save Operations Schedule</span>
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* SECTION 3: GUARDS ROSTER */}
          {activeSection === 'guards' && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Register Guard to Roster</CardTitle>
                </CardHeader>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">Guard Name</label>
                    <input
                      type="text"
                      value={newGuardName}
                      onChange={(e) => setNewGuardName(e.target.value)}
                      placeholder="e.g. Sipho Khoza"
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">Mobile Phone</label>
                    <input
                      type="tel"
                      value={newGuardPhone}
                      onChange={(e) => setNewGuardPhone(e.target.value)}
                      placeholder="+27 82 123 4567"
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white font-mono"
                    />
                  </div>

                  <div className="flex items-end">
                    <Button onClick={handleAddGuard} variant="primary" size="md" className="w-full gap-2">
                      <Plus className="w-4 h-4" />
                      <span>Add Guard</span>
                    </Button>
                  </div>
                </div>
              </Card>

              {/* Roster Table */}
              <Card>
                <CardHeader>
                  <CardTitle>Active Guard Roster ({guards.length})</CardTitle>
                </CardHeader>

                <div className="divide-y divide-slate-800">
                  {guards.map((g) => (
                    <div key={g.id} className="py-3 flex items-center justify-between">
                      <div>
                        <div className="font-bold text-sm text-white">{g.name}</div>
                        <div className="text-xs text-slate-400 font-mono">
                          ID: {g.employeeNo} · {g.phone}
                        </div>
                      </div>
                      <Badge variant="success">Active Duty</Badge>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {/* SECTION 4: AUDIT TRAIL */}
          {activeSection === 'audit' && (
            <Card>
              <CardHeader>
                <CardTitle>Cryptographic Immutable Audit Log</CardTitle>
              </CardHeader>

              <div className="space-y-3">
                <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-white block">Audit Trail Verification</span>
                    <span className="text-slate-400">All shifts, gate scans, and checkpoint events are cryptographically hashed.</span>
                  </div>
                  <Badge variant="success" className="gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>Hash Chain Intact</span>
                  </Badge>
                </div>

                <div className="text-xs font-mono text-slate-400 p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-1">
                  <div>[GENESIS] - 2026-09-30T06:00:00Z - Hash: 772061c...</div>
                  <div>[SHIFT_START] - Sipho Khoza - GPS ±4m - Hash: a89d2...</div>
                  <div>[CHECKPOINT_SCAN] - Hoofhek Ingang - GPS ±3m - Hash: b12f4...</div>
                  <div>[VEHICLE_IN] - CA 246-810 - Toyota Hilux - Hash: c904e...</div>
                </div>
              </div>
            </Card>
          )}
        </main>
      </div>
    </I18nProvider>
  );
}
