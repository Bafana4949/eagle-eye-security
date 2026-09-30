'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { 
  ShieldAlert, 
  MapPin, 
  Car, 
  ArrowLeft, 
  PhoneCall,
  Check,
  Compass
} from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/ui/MetricCard';
import { I18nProvider } from '@/lib/i18n/context';

export default function SupervisorDashboardPage() {
  const [activeTab, setActiveTab] = useState<'overview' | 'patrols' | 'incidents' | 'gate' | 'map'>('overview');
  const [acknowledgedAlerts, setAcknowledgedAlerts] = useState<string[]>([]);
  const [supervisorNote, setSupervisorNote] = useState<Record<string, string>>({});
  const [savedNotes, setSavedNotes] = useState<Record<string, string>>({});

  // Simulated live operational data
  const guards = [
    { id: '1', name: 'Wag 1 / Sipho Khoza', site: 'Dawie Boerdery', status: 'on_duty', shiftStart: '18:00', lastScan: '19:42', lastCheckpoint: 'Skaapkraal / East Kraal', compliance: 92, phone: '+27821112222' },
    { id: '2', name: 'Wag 2 / Petrus Ndlovu', site: 'Dawie Boerdery', status: 'on_duty', shiftStart: '18:00', lastScan: '19:15', lastCheckpoint: 'Hoofhek / Main Gate', compliance: 75, overdue: true, phone: '+27823334444' },
    { id: '3', name: 'Wag 3 / Thabo Mokoena', site: 'North Boundary', status: 'offline', shiftStart: '–', lastScan: 'Yesterday', lastCheckpoint: 'North Beacon', compliance: 88, phone: '+27825556666' }
  ];

  const alerts = [
    { id: 'alt-1', type: 'overdue_patrol', severity: 'warning', guard: 'Petrus Ndlovu', message: 'Round 2 overdue by 17 minutes at Hoofhek', time: '19:35' },
    { id: 'alt-2', type: 'sos_panic', severity: 'critical', guard: 'Sipho Khoza', message: 'SOS Panic triggered near East Kraal boundary', time: '19:44', lat: -25.6848, lng: 27.8152 }
  ];

  const incidents = [
    { id: 'inc-1', guard: 'Sipho Khoza', type: 'Fence Damaged', severity: 'high', description: 'Perimeter wire cut near north river bed. Footprints leading south.', time: '18:50', status: 'reported' },
    { id: 'inc-2', guard: 'Petrus Ndlovu', type: 'Open Gate', severity: 'medium', description: 'Workshop storage back gate found unlocked and open.', time: '19:10', status: 'acknowledged' }
  ];

  const gateActivity = [
    { id: 'g-1', plate: 'CA 552-194', vehicle: 'Toyota Hilux (White)', driver: 'J. van der Merwe', dir: 'IN', time: '18:15', purpose: 'Feed Delivery' },
    { id: 'g-2', plate: 'NW 910-882', vehicle: 'Isuzu D-Max (Silver)', driver: 'S. Botha', dir: 'OUT', time: '19:20', purpose: 'Veterinary Inspection', dwell: '1h 05m' }
  ];

  const checkpointsList = [
    { id: 'CP1', name: 'Hoofhek / Main Gate', lat: -25.684120, lng: 27.814520, lastScanned: '19:42', status: 'scanned' },
    { id: 'CP2', name: 'Skaapkraal / East Kraal', lat: -25.684890, lng: 27.815210, lastScanned: '19:35', status: 'scanned' },
    { id: 'CP3', name: 'Hoenderhok / Poultry Sheds', lat: -25.683500, lng: 27.814010, lastScanned: 'Pending', status: 'pending' },
    { id: 'CP4', name: 'Stoor & Werkswinkel', lat: -25.684300, lng: 27.813800, lastScanned: 'Pending', status: 'pending' }
  ];

  const handleAcknowledgeAlert = (alertId: string) => {
    setAcknowledgedAlerts((prev) => [...prev, alertId]);
  };

  const handleSaveNote = (incId: string) => {
    if (supervisorNote[incId]) {
      setSavedNotes((prev) => ({ ...prev, [incId]: supervisorNote[incId] }));
    }
  };

  return (
    <I18nProvider>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
        {/* Top Management Navbar */}
        <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur-md border-b border-slate-800 px-4 py-3">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/guard" className="p-2 rounded-2xl bg-slate-800 text-slate-300 hover:text-white">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div>
                <h1 className="text-lg font-black text-white tracking-tight flex items-center gap-2">
                  <span>Supervisor Operations Command</span>
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                </h1>
                <p className="text-xs text-slate-400">Dawie Boerdery · Aiguille Security Control Room</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link href="/viewer">
                <Button variant="secondary" size="sm" className="hidden sm:inline-flex text-xs">
                  Client Viewer
                </Button>
              </Link>
              <Link href="/admin">
                <Button variant="primary" size="sm" className="text-xs bg-blue-600 hover:bg-blue-500">
                  Admin Portal
                </Button>
              </Link>
            </div>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 max-w-6xl mx-auto w-full p-4 space-y-6">
          {/* Top Metric Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Guards On Duty"
              value="2"
              subValue="1 Offline"
              variant="success"
            />
            <MetricCard
              label="Active Alerts"
              value={alerts.filter((a) => !acknowledgedAlerts.includes(a.id)).length}
              subValue="1 Critical SOS"
              variant="danger"
            />
            <MetricCard
              label="Patrol Compliance"
              value="85%"
              subValue="Target 80%+"
              variant="info"
            />
            <MetricCard
              label="Vehicles on Farm"
              value="1"
              subValue="1 Exited today"
              variant="warning"
            />
          </div>

          {/* Critical SOS & Overdue Alert Banner */}
          {alerts.filter((a) => !acknowledgedAlerts.includes(a.id)).map((alert) => (
            <div
              key={alert.id}
              className={`p-4 rounded-3xl border flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-xl ${
                alert.severity === 'critical'
                  ? 'bg-rose-950/80 border-rose-600 text-rose-200'
                  : 'bg-amber-950/80 border-amber-600 text-amber-200'
              }`}
            >
              <div className="flex items-start gap-3">
                <ShieldAlert className={`w-6 h-6 flex-shrink-0 mt-0.5 ${alert.severity === 'critical' ? 'text-rose-500 animate-bounce' : 'text-amber-400'}`} />
                <div>
                  <h4 className="font-bold text-sm text-white flex items-center gap-2">
                    <span>{alert.guard}</span>
                    <Badge variant={alert.severity === 'critical' ? 'danger' : 'warning'}>
                      {alert.type.toUpperCase()}
                    </Badge>
                  </h4>
                  <p className="text-xs mt-0.5 text-slate-200 font-medium">{alert.message}</p>
                  <p className="text-[11px] font-mono text-slate-400 mt-1">Dispatched at {alert.time}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <a
                  href="tel:+27820001234"
                  className="px-3.5 py-2.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs flex items-center gap-1.5"
                >
                  <PhoneCall className="w-4 h-4 text-emerald-400" />
                  <span>Call Guard</span>
                </a>

                <Button
                  onClick={() => handleAcknowledgeAlert(alert.id)}
                  variant="primary"
                  size="sm"
                  className="gap-1.5 bg-rose-600 hover:bg-rose-500 text-white font-bold"
                >
                  <Check className="w-4 h-4" />
                  <span>Acknowledge Alert</span>
                </Button>
              </div>
            </div>
          ))}

          {/* Section Navigation Tabs */}
          <div className="flex items-center gap-2 border-b border-slate-800 pb-2 overflow-x-auto">
            {[
              { id: 'overview', label: 'Guards on Duty', count: guards.length },
              { id: 'patrols', label: 'Patrol Compliance' },
              { id: 'map', label: 'Operations Map' },
              { id: 'incidents', label: 'Incidents Feed', count: incidents.length },
              { id: 'gate', label: 'Gate Activity', count: gateActivity.length }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                className={`px-4 py-2.5 rounded-2xl text-xs font-bold whitespace-nowrap transition-all ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                {tab.label} {tab.count != null && `(${tab.count})`}
              </button>
            ))}
          </div>

          {/* TAB 1: Guards on Duty */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {guards.map((guard) => (
                <Card key={guard.id} className="border-slate-800 bg-slate-900/90 rounded-3xl p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h4 className="text-base font-bold text-white">{guard.name}</h4>
                      <p className="text-xs text-slate-400">{guard.site}</p>
                    </div>
                    <Badge variant={guard.status === 'on_duty' ? 'success' : 'neutral'}>
                      {guard.status === 'on_duty' ? 'ON DUTY' : 'OFFLINE'}
                    </Badge>
                  </div>

                  <div className="space-y-1.5 text-xs text-slate-300 py-2 border-y border-slate-800/80">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Shift Started:</span>
                      <span className="font-mono text-slate-200">{guard.shiftStart}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Last Scanned:</span>
                      <span className="font-mono text-slate-200">{guard.lastScan}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Checkpoint:</span>
                      <span className="font-semibold text-slate-200 truncate max-w-[160px]">{guard.lastCheckpoint}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <div>
                      <span className="text-[11px] text-slate-500 block">Compliance</span>
                      <span className={`text-base font-black ${guard.compliance >= 80 ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {guard.compliance}%
                      </span>
                    </div>

                    <a
                      href={`tel:${guard.phone}`}
                      className="p-2.5 rounded-2xl bg-slate-800 text-blue-400 hover:bg-slate-700"
                      title="Call Guard"
                    >
                      <PhoneCall className="w-5 h-5" />
                    </a>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* TAB 2: Patrol Compliance & Rounds */}
          {activeTab === 'patrols' && (
            <Card className="rounded-3xl border-slate-800 bg-slate-900/90">
              <CardHeader>
                <CardTitle>Hourly Round Verification Log</CardTitle>
                <Badge variant="info">Target: 1 Round / Hour</Badge>
              </CardHeader>
              <div className="space-y-3">
                {[
                  { round: 'Round 1 (18:00 – 19:00)', completed: '4/4 checkpoints', compliance: '100%', status: 'success' as const },
                  { round: 'Round 2 (19:00 – 20:00)', completed: '2/4 checkpoints', compliance: '50% (In Progress)', status: 'warning' as const },
                  { round: 'Round 3 (20:00 – 21:00)', completed: 'Scheduled', compliance: 'Upcoming', status: 'neutral' as const },
                  { round: 'Round 4 (21:00 – 22:00)', completed: 'Scheduled', compliance: 'Upcoming', status: 'neutral' as const }
                ].map((r, i) => (
                  <div key={i} className="p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
                    <div>
                      <span className="text-sm font-bold text-white block">{r.round}</span>
                      <span className="text-xs text-slate-400">{r.completed}</span>
                    </div>
                    <Badge variant={r.status}>{r.compliance}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* TAB 3: Operations Map */}
          {activeTab === 'map' && (
            <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-5">
              <CardHeader className="mb-3">
                <div className="flex items-center gap-2">
                  <Compass className="w-5 h-5 text-blue-400" />
                  <CardTitle>Perimeter Beacon & Patrol Grid</CardTitle>
                </div>
                <Badge variant="success">GPS Geofenced</Badge>
              </CardHeader>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {checkpointsList.map((cp) => (
                  <div
                    key={cp.id}
                    className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 flex items-start justify-between"
                  >
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-xl ${cp.status === 'scanned' ? 'bg-emerald-950 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                        <MapPin className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-white">{cp.name}</h4>
                        <p className="text-xs font-mono text-slate-400 mt-0.5">
                          {cp.lat.toFixed(5)}, {cp.lng.toFixed(5)}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          Last Scanned: <span className="font-semibold text-slate-300">{cp.lastScanned}</span>
                        </p>
                      </div>
                    </div>
                    <Badge variant={cp.status === 'scanned' ? 'success' : 'neutral'}>
                      {cp.status === 'scanned' ? 'Active' : 'Pending'}
                    </Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* TAB 4: Incidents Feed */}
          {activeTab === 'incidents' && (
            <div className="space-y-3">
              {incidents.map((inc) => (
                <Card key={inc.id} className="p-4 rounded-3xl border-slate-800 bg-slate-900/90">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant={inc.severity === 'high' ? 'danger' : 'warning'}>
                          {inc.type}
                        </Badge>
                        <span className="text-xs text-slate-400">Reported by {inc.guard}</span>
                      </div>
                      <p className="text-sm text-slate-200 mt-2 font-medium">{inc.description}</p>
                    </div>
                    <span className="text-xs font-mono text-slate-500">{inc.time}</span>
                  </div>

                  {savedNotes[inc.id] && (
                    <div className="my-2 p-2.5 rounded-xl bg-blue-950/40 border border-blue-900/60 text-xs text-blue-200 font-mono">
                      <span className="font-bold text-blue-400">Supervisor Note: </span>
                      <span>{savedNotes[inc.id]}</span>
                    </div>
                  )}

                  <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-3">
                    <input
                      type="text"
                      placeholder="Add supervisor notes..."
                      value={supervisorNote[inc.id] || ''}
                      onChange={(e) => setSupervisorNote({ ...supervisorNote, [inc.id]: e.target.value })}
                      className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 w-full"
                    />

                    <Button variant="secondary" size="sm" onClick={() => handleSaveNote(inc.id)}>
                      Save Note
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* TAB 5: Gate Activity */}
          {activeTab === 'gate' && (
            <Card className="rounded-3xl border-slate-800 bg-slate-900/90">
              <CardHeader className="mb-2">
                <CardTitle className="text-base">Today&apos;s Gate Log</CardTitle>
              </CardHeader>
              <div className="space-y-3">
                {gateActivity.map((v) => (
                  <div key={v.id} className="p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2.5 rounded-xl ${v.dir === 'IN' ? 'bg-blue-950 text-blue-400' : 'bg-emerald-950 text-emerald-400'}`}>
                        <Car className="w-5 h-5" />
                      </div>
                      <div>
                        <span className="font-mono font-bold text-white text-sm block">{v.plate}</span>
                        <span className="text-xs text-slate-400">{v.vehicle} · {v.driver}</span>
                        <span className="text-[11px] text-slate-500 block mt-0.5">{v.purpose}</span>
                      </div>
                    </div>

                    <div className="text-right">
                      <Badge variant={v.dir === 'IN' ? 'info' : 'success'}>{v.dir}</Badge>
                      <span className="text-xs font-mono text-slate-400 block mt-1">{v.time}</span>
                      {v.dwell && (
                        <span className="text-[10px] font-mono text-amber-400 block">Dwell: {v.dwell}</span>
                      )}
                    </div>
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
