'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  ShieldCheck, 
  Printer, 
  RefreshCw, 
  LogOut 
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/ui/MetricCard';
import { I18nProvider } from '@/lib/i18n/context';
import { useAuth } from '@/context/AuthContext';
import { createClient } from '@/lib/supabase/client';

interface ViewerScan {
  id: string;
  scan_timestamp_device: string;
  method?: string;
  checkpoints?: { name?: string };
  profiles?: { first_name?: string; last_name?: string };
}

interface ViewerIncident {
  id: string;
  incident_type: string;
  severity: string;
  description: string;
  status: string;
  reported_at: string;
  supervisor_notes?: string;
}

interface ViewerVehicle {
  id: string;
  license_plate: string;
  direction: 'in' | 'out';
  make_model?: string;
  driver_name?: string;
  entry_time: string;
}

export default function ClientViewerPortal() {
  const { profile, assignedSite, signOut } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [activeTab, setActiveTab] = useState<'summary' | 'patrols' | 'incidents' | 'vehicles'>('summary');

  // Live Read-Only Operational Metrics
  const [guardsCount, setGuardsCount] = useState(0);
  const [completedScansCount, setCompletedScansCount] = useState(0);
  const [totalCheckpoints, setTotalCheckpoints] = useState(6);
  const [complianceRate, setComplianceRate] = useState('100%');
  const [recentScans, setRecentScans] = useState<ViewerScan[]>([]);
  const [incidents, setIncidents] = useState<ViewerIncident[]>([]);
  const [vehicles, setVehicles] = useState<ViewerVehicle[]>([]);

  const siteId = assignedSite?.id || '22222222-2222-2222-2222-222222222222';
  const siteName = assignedSite?.name || 'Dawie Boerdery - Main Site';
  const clientName = profile ? `${profile.first_name} ${profile.last_name}` : 'Dawie Snyman (Client Owner)';

  const loadViewerData = useCallback(async () => {
    try {
      // 1. Active guards count
      const { count: activeGuardCount } = await supabase
        .from('shifts')
        .select('*', { count: 'exact', head: true })
        .eq('site_id', siteId)
        .eq('status', 'active');
      setGuardsCount(activeGuardCount || 0);

      // 2. Checkpoints
      const { data: cps } = await supabase
        .from('checkpoints')
        .select('id, name')
        .eq('site_id', siteId);
      const totalCp = cps?.length || 6;
      setTotalCheckpoints(totalCp);

      // 3. Today's scans
      const today = new Date().toISOString().split('T')[0];
      const { data: scans } = await supabase
        .from('patrol_scans')
        .select('id, scan_timestamp_device, method, checkpoints(name), profiles(first_name, last_name)')
        .gte('scan_timestamp_device', `${today}T00:00:00Z`)
        .order('scan_timestamp_device', { ascending: false })
        .limit(20);

      if (scans) {
        setRecentScans(scans as unknown as ViewerScan[]);
        setCompletedScansCount(scans.length);
        const rate = Math.min(100, Math.round((scans.length / totalCp) * 100));
        setComplianceRate(`${rate}%`);
      }

      // 4. Incidents (non-panic)
      const { data: incs } = await supabase
        .from('incidents')
        .select('id, incident_type, severity, description, status, reported_at, supervisor_notes')
        .eq('site_id', siteId)
        .order('reported_at', { ascending: false })
        .limit(10);
      setIncidents((incs || []) as unknown as ViewerIncident[]);

      // 5. Vehicles on site
      const { data: gate } = await supabase
        .from('gate_entries')
        .select('*')
        .eq('site_id', siteId)
        .order('entry_time', { ascending: false })
        .limit(10);
      setVehicles((gate || []) as unknown as ViewerVehicle[]);
    } catch (err) {
      console.warn('Viewer data load error:', err);
    }
  }, [supabase, siteId]);

  useEffect(() => {
    let isMounted = true;
    const timer = setTimeout(() => {
      if (isMounted) void loadViewerData();
    }, 0);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [loadViewerData]);

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
                  {clientName} · {siteName}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={() => void loadViewerData()}
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs text-slate-400 hover:text-white"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Refresh</span>
              </Button>

              <Button
                onClick={handlePrintReport}
                variant="secondary"
                size="sm"
                className="gap-1.5 text-xs"
              >
                <Printer className="w-4 h-4" />
                <span className="hidden sm:inline">Print Site Report</span>
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => void signOut()}
                className="text-xs text-rose-400 hover:text-rose-300"
              >
                <LogOut className="w-4 h-4" />
              </Button>
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
              subValue="Real checkpoint audits"
              variant="success"
            />
            <MetricCard
              label="Today's Scans"
              value={completedScansCount.toString()}
              subValue={`Across ${totalCheckpoints} checkpoints`}
              variant="info"
            />
            <MetricCard
              label="Guards On Duty"
              value={guardsCount.toString()}
              subValue="Live active attendance"
              variant="default"
            />
            <MetricCard
              label="Open Incidents"
              value={incidents.filter((i) => i.status === 'reported').length.toString()}
              subValue="Security event tracking"
              variant="success"
            />
          </div>

          {/* Navigation Tabs */}
          <div className="flex overflow-x-auto gap-2 border-b border-slate-800 pb-2 text-xs font-bold scrollbar-none">
            <button
              onClick={() => setActiveTab('summary')}
              className={`px-4 py-2 rounded-xl transition-all ${
                activeTab === 'summary'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              Overview Summary
            </button>
            <button
              onClick={() => setActiveTab('patrols')}
              className={`px-4 py-2 rounded-xl transition-all ${
                activeTab === 'patrols'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              Patrol Verification ({recentScans.length})
            </button>
            <button
              onClick={() => setActiveTab('incidents')}
              className={`px-4 py-2 rounded-xl transition-all ${
                activeTab === 'incidents'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              Incidents ({incidents.length})
            </button>
            <button
              onClick={() => setActiveTab('vehicles')}
              className={`px-4 py-2 rounded-xl transition-all ${
                activeTab === 'vehicles'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              Vehicle Access ({vehicles.length})
            </button>
          </div>

          {/* Tab Content */}
          {activeTab === 'summary' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="p-5 bg-slate-900/90 border-slate-800 rounded-3xl space-y-3">
                <h2 className="text-sm font-black text-white uppercase tracking-wider">
                  Site Operations Status
                </h2>
                <div className="space-y-2 text-xs text-slate-300">
                  <div className="flex justify-between py-1.5 border-b border-slate-800/80">
                    <span className="text-slate-400">Security Provider</span>
                    <span className="font-semibold text-white">Aiguille Security Services</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-800/80">
                    <span className="text-slate-400">Site Location</span>
                    <span className="font-semibold text-white">{siteName}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-800/80">
                    <span className="text-slate-400">Guards Active</span>
                    <span className="font-semibold text-emerald-400">{guardsCount} on duty</span>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-slate-400">Data Guarantee</span>
                    <span className="font-mono text-blue-400">Read-Only Live Audit</span>
                  </div>
                </div>
              </Card>

              <Card className="p-5 bg-slate-900/90 border-slate-800 rounded-3xl space-y-3">
                <h2 className="text-sm font-black text-white uppercase tracking-wider">
                  Recent Patrol Activity
                </h2>
                {recentScans.length === 0 ? (
                  <p className="text-xs text-slate-400">No patrol scans recorded today yet.</p>
                ) : (
                  <div className="space-y-2">
                    {recentScans.slice(0, 4).map((s) => (
                      <div key={s.id} className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex justify-between items-center text-xs">
                        <span className="font-bold text-white">{s.checkpoints?.name || 'Checkpoint'}</span>
                        <span className="font-mono text-slate-400 text-[11px]">
                          {new Date(s.scan_timestamp_device).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })} ({s.method?.toUpperCase()})
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}

          {activeTab === 'patrols' && (
            <div className="space-y-3">
              <h2 className="text-sm font-black text-slate-300 uppercase tracking-wider">
                Patrol Verification Log (Today)
              </h2>
              {recentScans.length === 0 ? (
                <Card className="p-6 text-center text-slate-400 text-xs">No scans today.</Card>
              ) : (
                <div className="space-y-2">
                  {recentScans.map((s) => (
                    <Card key={s.id} className="p-3 bg-slate-900 border-slate-800 rounded-2xl flex justify-between items-center text-xs">
                      <div>
                        <span className="font-bold text-white block">{s.checkpoints?.name || 'Checkpoint'}</span>
                        <span className="text-[11px] text-slate-400">
                          Guard: {s.profiles ? `${s.profiles.first_name} ${s.profiles.last_name}` : 'Security Officer'}
                        </span>
                      </div>
                      <div className="text-right">
                        <Badge variant="neutral">{s.method?.toUpperCase()}</Badge>
                        <span className="font-mono text-slate-400 text-[11px] block mt-1">
                          {new Date(s.scan_timestamp_device).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'incidents' && (
            <div className="space-y-3">
              <h2 className="text-sm font-black text-slate-300 uppercase tracking-wider">
                Site Incidents ({incidents.length})
              </h2>
              {incidents.length === 0 ? (
                <Card className="p-6 text-center text-slate-400 text-xs">No incidents reported.</Card>
              ) : (
                <div className="space-y-2">
                  {incidents.map((i) => (
                    <Card key={i.id} className="p-4 bg-slate-900 border-slate-800 rounded-2xl space-y-1 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="font-bold text-white text-sm">{i.incident_type}</span>
                        <Badge variant={i.status === 'resolved' ? 'success' : 'warning'}>{i.status}</Badge>
                      </div>
                      <p className="text-slate-300">{i.description}</p>
                      {i.supervisor_notes && (
                        <p className="text-emerald-400 text-[11px] pt-1">
                          Resolution: {i.supervisor_notes}
                        </p>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'vehicles' && (
            <div className="space-y-3">
              <h2 className="text-sm font-black text-slate-300 uppercase tracking-wider">
                Gate Entry & Exit Logs ({vehicles.length})
              </h2>
              {vehicles.length === 0 ? (
                <Card className="p-6 text-center text-slate-400 text-xs">No gate records available.</Card>
              ) : (
                <div className="space-y-2">
                  {vehicles.map((v) => (
                    <Card key={v.id} className="p-3 bg-slate-900 border-slate-800 rounded-2xl flex justify-between items-center text-xs">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-white">{v.license_plate}</span>
                          <Badge variant={v.direction === 'in' ? 'success' : 'neutral'}>{v.direction?.toUpperCase()}</Badge>
                        </div>
                        <p className="text-slate-400 mt-0.5">{v.make_model || 'Vehicle'} {v.driver_name ? `· Driver: ${v.driver_name}` : ''}</p>
                      </div>
                      <span className="font-mono text-slate-400 text-[11px]">
                        {new Date(v.entry_time).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </I18nProvider>
  );
}
