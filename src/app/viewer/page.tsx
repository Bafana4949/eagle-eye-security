'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { 
  ShieldCheck, 
  Printer, 
  Building,
  CheckCircle2
} from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/ui/MetricCard';
import { I18nProvider } from '@/lib/i18n/context';

export default function ClientViewerPortal() {
  const [selectedSite] = useState('Dawie Boerdery - Main Farm');
  const [activeTab, setActiveTab] = useState<'summary' | 'patrols' | 'incidents' | 'vehicles'>('summary');

  const clientName = 'Dawie Snyman (Client Owner)';
  const orgName = 'Aiguille Security Services';

  // Read-only operational metrics
  const completedRounds = 11;
  const targetRounds = 12;
  const complianceRate = '91.6%';

  const handlePrintReport = () => {
    window.print();
  };

  return (
    <I18nProvider>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
        {/* Top Header */}
        <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur-md border-b border-slate-800 px-4 py-3">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-blue-700 to-indigo-600 flex items-center justify-center text-white shadow-md">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-base font-black text-white tracking-tight flex items-center gap-2">
                  <span>Client Operations Portal</span>
                  <Badge variant="info">Read Only</Badge>
                </h1>
                <p className="text-xs text-slate-400">
                  {clientName} · {selectedSite}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={handlePrintReport}
                variant="secondary"
                size="sm"
                className="gap-1.5 text-xs"
              >
                <Printer className="w-4 h-4" />
                <span className="hidden sm:inline">Print Site Report</span>
              </Button>

              <Link href="/login">
                <Button variant="ghost" size="sm" className="text-xs text-slate-400">
                  Exit
                </Button>
              </Link>
            </div>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 max-w-6xl mx-auto w-full p-4 space-y-6">
          {/* Top Metrics Banner */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Patrol Compliance"
              value={complianceRate}
              subValue="Target: 80%+"
              variant="success"
            />
            <MetricCard
              label="Completed Rounds"
              value={`${completedRounds} / ${targetRounds}`}
              subValue="1 Remaining"
              variant="info"
            />
            <MetricCard
              label="Guards On Duty"
              value="2"
              subValue="Full Attendance"
              variant="default"
            />
            <MetricCard
              label="Open Incidents"
              value="0"
              subValue="All Resolved"
              variant="success"
            />
          </div>

          {/* Site Overview Banner */}
          <div className="p-4.5 rounded-3xl bg-slate-900 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-blue-950 border border-blue-800/60 flex items-center justify-center text-blue-400">
                <Building className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">{selectedSite}</h2>
                <p className="text-xs text-slate-400">
                  Contractor: <span className="text-slate-200 font-semibold">{orgName}</span> · Active Shift: Night Shift
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Badge variant="success">Perimeter Secured</Badge>
              <Badge variant="neutral">GPS Verified</Badge>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
            {[
              { id: 'summary', label: 'Operations Summary' },
              { id: 'patrols', label: 'Patrol Rounds History' },
              { id: 'incidents', label: 'Incident Records' },
              { id: 'vehicles', label: 'Vehicle Entry Logs' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                className={`px-4 py-2.5 rounded-2xl text-xs font-bold transition-all ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* TAB 1: Summary */}
          {activeTab === 'summary' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
                <CardHeader>
                  <CardTitle className="text-sm">Tonight&apos;s Guard Attendance</CardTitle>
                </CardHeader>
                <div className="space-y-3">
                  <div className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
                    <div>
                      <span className="text-sm font-bold text-white block">Sipho Khoza</span>
                      <span className="text-xs text-slate-400">Guard Station A · On duty since 18:00</span>
                    </div>
                    <Badge variant="success">Active</Badge>
                  </div>

                  <div className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
                    <div>
                      <span className="text-sm font-bold text-white block">Petrus Ndlovu</span>
                      <span className="text-xs text-slate-400">Main Gate Post · On duty since 18:00</span>
                    </div>
                    <Badge variant="success">Active</Badge>
                  </div>
                </div>
              </Card>

              <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
                <CardHeader>
                  <CardTitle className="text-sm">Perimeter Checkpoint Verification</CardTitle>
                </CardHeader>
                <div className="space-y-2">
                  {[
                    { name: 'Hoofhek / Main Gate', scans: '11 times verified', status: 'verified' as const },
                    { name: 'Skaapkraal / East Kraal', scans: '11 times verified', status: 'verified' as const },
                    { name: 'Hoenderhok / Poultry Sheds', scans: '10 times verified', status: 'verified' as const },
                    { name: 'Stoor & Werkswinkel', scans: '11 times verified', status: 'verified' as const }
                  ].map((cp, idx) => (
                    <div key={idx} className="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="font-semibold text-slate-200">{cp.name}</span>
                      </div>
                      <span className="text-slate-400 font-mono text-[11px]">{cp.scans}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {/* TAB 2: Patrol Rounds */}
          {activeTab === 'patrols' && (
            <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
              <CardHeader>
                <CardTitle className="text-sm">Verified Patrol Rounds (18:00 – 06:00)</CardTitle>
                <Badge variant="success">11 / 12 Verified</Badge>
              </CardHeader>
              <div className="space-y-2.5 max-h-96 overflow-y-auto">
                {[
                  { round: 1, time: '18:00 – 19:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 2, time: '19:00 – 20:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 3, time: '20:00 – 21:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 4, time: '21:00 – 22:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 5, time: '22:00 – 23:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 6, time: '23:00 – 00:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 7, time: '00:00 – 01:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 8, time: '01:00 – 02:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 9, time: '02:00 – 03:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 10, time: '03:00 – 04:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 11, time: '04:00 – 05:00', points: '4 of 4 points', status: 'Compliant' },
                  { round: 12, time: '05:00 – 06:00', points: 'In progress', status: 'Current' }
                ].map((r) => (
                  <div key={r.round} className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800 flex items-center justify-between text-xs">
                    <div>
                      <span className="font-bold text-white block">Patrol Round {r.round} ({r.time})</span>
                      <span className="text-slate-400">{r.points}</span>
                    </div>
                    <Badge variant={r.status === 'Compliant' ? 'success' : 'info'}>
                      {r.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* TAB 3: Incidents */}
          {activeTab === 'incidents' && (
            <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
              <CardHeader>
                <CardTitle className="text-sm">Historical Incident Log</CardTitle>
              </CardHeader>
              <div className="space-y-3">
                <div className="p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="warning">Fence Wire Cut</Badge>
                        <span className="text-xs text-slate-400">Ref: INC-2026-881294</span>
                      </div>
                      <p className="text-sm text-slate-200 mt-2 font-medium">
                        Perimeter fence wire cut along south river boundary. Guard reported immediately; fence repaired by morning maintenance team.
                      </p>
                      <p className="text-[11px] font-mono text-slate-400 mt-1">Logged: 2026-09-29 23:14</p>
                    </div>
                    <Badge variant="success">Resolved</Badge>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* TAB 4: Vehicles */}
          {activeTab === 'vehicles' && (
            <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
              <CardHeader>
                <CardTitle className="text-sm">Site Vehicle Traffic Register</CardTitle>
              </CardHeader>
              <div className="space-y-2.5">
                {[
                  { plate: 'CA 552-194', vehicle: 'Toyota Hilux (White)', driver: 'J. van der Merwe', dir: 'IN', time: '18:15', purpose: 'Feed Delivery' },
                  { plate: 'NW 910-882', vehicle: 'Isuzu D-Max (Silver)', driver: 'S. Botha', dir: 'OUT', time: '19:20', purpose: 'Veterinary Inspection', dwell: '1h 05m' }
                ].map((v, i) => (
                  <div key={i} className="p-3 rounded-2xl bg-slate-950/70 border border-slate-800 flex items-center justify-between text-xs">
                    <div>
                      <span className="font-mono font-bold text-white text-sm block">{v.plate}</span>
                      <span className="text-slate-400">{v.vehicle} · {v.driver}</span>
                      <span className="text-[11px] text-slate-500 block mt-0.5">{v.purpose}</span>
                    </div>
                    <div className="text-right">
                      <Badge variant={v.dir === 'IN' ? 'info' : 'success'}>{v.dir}</Badge>
                      <span className="text-[11px] font-mono text-slate-400 block mt-1">{v.time}</span>
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
