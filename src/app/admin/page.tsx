'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  Building2, 
  Users, 
  QrCode, 
  Printer, 
  Plus, 
  Trash2, 
  Save, 
  ArrowLeft,
  FileSpreadsheet
} from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { I18nProvider } from '@/lib/i18n/context';
import { Checkpoint } from '@/types/models';
import { offlineDB } from '@/lib/offline/db';

export default function AdminPortalPage() {
  const [activeSection, setActiveSection] = useState<'checkpoints' | 'sites' | 'guards' | 'branding' | 'audit'>('checkpoints');
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [newCpName, setNewCpName] = useState('');
  const [newCpRadius, setNewCpRadius] = useState(50);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Site Configuration State
  const [siteName, setSiteName] = useState('Dawie Boerdery - Main Site');
  const [siteCode, setSiteCode] = useState('DW-01');
  const [dayStart, setDayStart] = useState('06:00');
  const [dayEnd, setDayEnd] = useState('18:00');
  const [nightStart, setNightStart] = useState('18:00');
  const [nightEnd, setNightEnd] = useState('06:00');
  const [roundInterval, setRoundInterval] = useState(60);
  const [emergencyPhone, setEmergencyPhone] = useState('+27 82 999 4321');

  // Guards Roster State
  const [guards, setGuards] = useState([
    { id: '1', name: 'Wag 1 / Sipho Khoza', employeeNo: 'G-101', role: 'guard', phone: '+27 82 111 2222', active: true },
    { id: '2', name: 'Wag 2 / Petrus Ndlovu', employeeNo: 'G-102', role: 'guard', phone: '+27 82 333 4444', active: true },
    { id: '3', name: 'Dawie Snyman', employeeNo: 'M-001', role: 'admin', phone: '+27 82 999 4321', active: true }
  ]);
  const [newGuardName, setNewGuardName] = useState('');
  const [newGuardPhone, setNewGuardPhone] = useState('');

  useEffect(() => {
    let isMounted = true;
    const fetchCheckpoints = async () => {
      if (offlineDB) {
        const cps = await offlineDB.checkpoints.toArray();
        if (isMounted) {
          setCheckpoints(cps);
        }
      }
    };
    void fetchCheckpoints();
    return () => {
      isMounted = false;
    };
  }, []);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  const handleAddCheckpoint = async () => {
    if (!newCpName.trim()) {
      showToast('Please enter a checkpoint name');
      return;
    }

    // Generate secure random QR hash (avoids predictable sequential values)
    const randomSuffix = crypto.randomUUID().slice(0, 8).toUpperCase();
    const qrCodeHash = `EE-CP-${randomSuffix}`;

    const newCp: Checkpoint = {
      id: crypto.randomUUID(),
      siteId: '22222222-2222-2222-2222-222222222222',
      name: newCpName.trim(),
      qrCodeHash,
      permittedRadiusMeters: newCpRadius,
      orderIndex: checkpoints.length + 1,
      isActive: true
    };

    if (offlineDB) {
      await offlineDB.checkpoints.add(newCp);
      setCheckpoints([...checkpoints, newCp]);
    }

    setNewCpName('');
    showToast(`Checkpoint added with code: ${qrCodeHash}`);
  };

  const handleDeleteCheckpoint = async (id: string) => {
    if (confirm('Delete this checkpoint?')) {
      if (offlineDB) {
        await offlineDB.checkpoints.delete(id);
        setCheckpoints(checkpoints.filter((c) => c.id !== id));
      }
      showToast('Checkpoint removed');
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

  return (
    <I18nProvider>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
        {/* Toast Alert */}
        {toastMsg && (
          <div className="fixed top-16 left-4 right-4 z-50 p-3 bg-blue-600 text-white font-semibold text-sm rounded-xl shadow-2xl text-center max-w-md mx-auto">
            {toastMsg}
          </div>
        )}

        {/* Header */}
        <header className="sticky top-0 z-30 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 py-3">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/supervisor" className="p-2 rounded-xl bg-slate-800 text-slate-300 hover:text-white">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div>
                <h1 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                  <span>Administration & Security Settings</span>
                  <Badge variant="neutral">Admin Role</Badge>
                </h1>
                <p className="text-xs text-slate-400">Manage sites, checkpoints, roster & compliance</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button onClick={handlePrintCards} variant="primary" size="sm" className="gap-1.5">
                <Printer className="w-4 h-4" />
                <span>Print QR Cards</span>
              </Button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 max-w-6xl mx-auto w-full p-4 space-y-6">
          {/* Section Navigation */}
          <div className="flex items-center gap-2 border-b border-slate-800 pb-2 overflow-x-auto">
            {[
              { id: 'checkpoints', label: 'Checkpoints & QR Codes', icon: QrCode },
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
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* SECTION 1: CHECKPOINTS & QR GENERATOR */}
          {activeSection === 'checkpoints' && (
            <div className="space-y-6">
              {/* Add Checkpoint Card */}
              <Card>
                <CardHeader>
                  <CardTitle>Create New Checkpoint</CardTitle>
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
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">
                      Validation Radius (meters)
                    </label>
                    <select
                      value={newCpRadius}
                      onChange={(e) => setNewCpRadius(Number(e.target.value))}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                    <span>Generate Secure Checkpoint QR</span>
                  </Button>
                </div>
              </Card>

              {/* Checkpoints Grid */}
              <Card>
                <CardHeader className="flex items-center justify-between">
                  <CardTitle>Configured Checkpoints ({checkpoints.length})</CardTitle>
                  <Button onClick={handlePrintCards} variant="secondary" size="sm" className="gap-2">
                    <Printer className="w-4 h-4 text-blue-400" />
                    <span>Print All Checkpoint Cards</span>
                  </Button>
                </CardHeader>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                  {checkpoints.map((cp, idx) => (
                    <div
                      key={cp.id}
                      className="p-4 rounded-2xl bg-slate-900 border border-slate-800 flex items-start justify-between"
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-12 h-12 bg-white rounded-xl p-1 flex items-center justify-center flex-shrink-0">
                          {/* Visual QR representation preview */}
                          <div className="w-full h-full bg-slate-950 rounded flex items-center justify-center text-[10px] font-mono text-white font-black">
                            QR
                          </div>
                        </div>
                        <div>
                          <h4 className="font-bold text-sm text-white">{cp.name}</h4>
                          <p className="text-xs font-mono text-blue-400 font-semibold mt-0.5">
                            {cp.qrCodeHash}
                          </p>
                          <p className="text-[11px] text-slate-400 mt-1">
                            Radius: {cp.permittedRadiusMeters}m · Order: #{idx + 1}
                          </p>
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
                  ))}
                </div>
              </Card>

              {/* Printable QR Cards Canvas (Used when user triggers Print) */}
              <div id="printable-cards" className="hidden print:block bg-white text-black p-8">
                <h1 className="text-2xl font-black mb-6 text-center">EAGLE EYE CHECKPOINT CARDS</h1>
                <div className="grid grid-cols-2 gap-8">
                  {checkpoints.map((cp) => (
                    <div key={cp.id} className="border-4 border-black p-6 rounded-2xl text-center">
                      <div className="w-48 h-48 mx-auto border-2 border-black flex items-center justify-center mb-4 text-xs font-mono">
                        [QR CODE: {cp.qrCodeHash}]
                      </div>
                      <h2 className="text-xl font-bold">{cp.name}</h2>
                      <p className="text-sm font-mono mt-1">{cp.qrCodeHash}</p>
                      <p className="text-xs mt-2 text-gray-600">Aiguille Security & Dawie Boerdery</p>
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
                    <span className="text-xs font-bold text-blue-400 block mb-2">🌙 Night Shift Hours</span>
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
                      <option value={60}>Every 60 minutes (Default)</option>
                      <option value={90}>Every 90 minutes</option>
                      <option value={120}>Every 120 minutes</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">
                      Emergency Supervisor Phone
                    </label>
                    <input
                      type="text"
                      value={emergencyPhone}
                      onChange={(e) => setEmergencyPhone(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
                    />
                  </div>
                </div>

                <div className="pt-4 flex justify-end">
                  <Button onClick={() => showToast('Site configuration updated')} variant="primary" size="md">
                    <Save className="w-4 h-4 mr-2" />
                    <span>Save Site Settings</span>
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* SECTION 3: GUARDS & ROSTER */}
          {activeSection === 'guards' && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Add Guard to Roster</CardTitle>
                </CardHeader>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">Guard Name</label>
                    <input
                      type="text"
                      value={newGuardName}
                      onChange={(e) => setNewGuardName(e.target.value)}
                      placeholder="e.g. Samuel Khumalo"
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-400 block mb-1">Phone Number</label>
                    <input
                      type="text"
                      value={newGuardPhone}
                      onChange={(e) => setNewGuardPhone(e.target.value)}
                      placeholder="+27 82 000 0000"
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button onClick={handleAddGuard} variant="primary" size="md" className="w-full">
                      Add Guard
                    </Button>
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>User & Guard Roster ({guards.length})</CardTitle>
                </CardHeader>
                <div className="space-y-3">
                  {guards.map((g) => (
                    <div key={g.id} className="p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-950 border border-blue-600 flex items-center justify-center font-bold text-sm text-blue-400">
                          {g.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <span className="font-bold text-sm text-white block">{g.name}</span>
                          <span className="text-xs text-slate-400">{g.employeeNo} · {g.phone}</span>
                        </div>
                      </div>

                      <Badge variant={g.role === 'admin' ? 'info' : 'success'}>
                        {g.role.toUpperCase()}
                      </Badge>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {/* SECTION 4: AUDIT TRAIL LOGS */}
          {activeSection === 'audit' && (
            <Card>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>Authoritative System Audit Trail</CardTitle>
                <Badge variant="info">Immutable Monotonic Log</Badge>
              </CardHeader>
              <div className="space-y-2">
                {[
                  { action: 'SHIFT_START', actor: 'Sipho Khoza', detail: 'Clock-in verified with front selfie', time: '18:00:12' },
                  { action: 'CHECKPOINT_SCAN', actor: 'Sipho Khoza', detail: 'Hoofhek scanned. GPS verified: 12m from beacon', time: '18:15:44' },
                  { action: 'GATE_ENTRY', actor: 'Sipho Khoza', detail: 'Vehicle CA 552-194 entered (Diesel delivery)', time: '18:22:01' },
                  { action: 'INCIDENT_REPORT', actor: 'Petrus Ndlovu', detail: 'Fence cut reported on North Boundary', time: '18:50:30' }
                ].map((log, i) => (
                  <div key={i} className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between text-xs">
                    <div>
                      <span className="font-mono font-bold text-blue-400 mr-2">[{log.action}]</span>
                      <span className="text-slate-200">{log.detail}</span>
                      <span className="text-slate-500 block mt-0.5">By {log.actor}</span>
                    </div>
                    <span className="font-mono text-slate-400">{log.time}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </main>
      </div>
    </I18nProvider>
  );
}
