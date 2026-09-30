'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { 
  ShieldAlert, 
  ArrowLeft, 
  PhoneCall, 
  Check, 
  RefreshCw,
  LogOut
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/ui/MetricCard';
import { useAuth } from '@/context/AuthContext';
import { createClient } from '@/lib/supabase/client';

interface LiveGuardOnDuty {
  id: string;
  name: string;
  site: string;
  shiftStart: string;
  lastScan?: string;
  phone?: string;
}

interface LivePanicAlert {
  id: string;
  guardName: string;
  message: string;
  time: string;
  status: string;
  lat?: number;
  lng?: number;
}

interface LiveIncident {
  id: string;
  guardName: string;
  type: string;
  severity: string;
  description: string;
  time: string;
  status: string;
  notes?: string;
}

interface LiveGateEntry {
  id: string;
  plate: string;
  vehicle: string;
  driver?: string;
  dir: 'in' | 'out';
  time: string;
  purpose?: string;
  dwell?: string;
}

interface LiveCheckpoint {
  id: string;
  name: string;
  lat?: number;
  lng?: number;
  lastScanned?: string;
  status: 'scanned' | 'pending';
}

export default function SupervisorDashboardPage() {
  const router = useRouter();
  const { user, assignedSite, signOut } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [activeTab, setActiveTab] = useState<'overview' | 'patrols' | 'incidents' | 'gate' | 'map'>('overview');

  // Live Database Operational State
  const [guards, setGuards] = useState<LiveGuardOnDuty[]>([]);
  const [alerts, setAlerts] = useState<LivePanicAlert[]>([]);
  const [incidents, setIncidents] = useState<LiveIncident[]>([]);
  const [gateActivity, setGateActivity] = useState<LiveGateEntry[]>([]);
  const [checkpointsList, setCheckpointsList] = useState<LiveCheckpoint[]>([]);
  const [complianceRate, setComplianceRate] = useState<number>(100);

  const [supervisorNote, setSupervisorNote] = useState<Record<string, string>>({});

  const siteId = assignedSite?.id || '22222222-2222-2222-2222-222222222222';
  const siteName = assignedSite?.name || 'Dawie Boerdery - Main Site';

  // Load real operational data from Supabase
  const loadOperationsData = useCallback(async () => {
    try {
      // 1. Fetch active shifts & guards on duty
      const { data: activeShifts } = await supabase
        .from('shifts')
        .select('id, guard_id, actual_start, scheduled_start, profiles(first_name, last_name, phone_number)')
        .eq('site_id', siteId)
        .eq('status', 'active');

      if (activeShifts) {
        const mappedGuards: LiveGuardOnDuty[] = activeShifts.map((s) => {
          const p = s.profiles as unknown as { first_name?: string; last_name?: string; phone_number?: string } | null;
          return {
            id: s.id,
            name: p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : 'Active Guard',
            site: siteName,
            shiftStart: new Date(s.actual_start || s.scheduled_start).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }),
            phone: p?.phone_number || '+27 82 111 2222'
          };
        });
        setGuards(mappedGuards);
      }

      // 2. Fetch live SOS panic alerts
      const { data: panicData } = await supabase
        .from('panic_alerts')
        .select('id, triggered_at, status, latitude, longitude, profiles(first_name, last_name)')
        .eq('site_id', siteId)
        .order('triggered_at', { ascending: false })
        .limit(10);

      if (panicData) {
        const mappedAlerts: LivePanicAlert[] = panicData.map((p) => {
          const prof = p.profiles as unknown as { first_name?: string; last_name?: string } | null;
          const gName = prof ? `${prof.first_name || ''} ${prof.last_name || ''}`.trim() : 'Guard';
          return {
            id: p.id,
            guardName: gName,
            message: `SOS Panic alert triggered by ${gName}`,
            time: new Date(p.triggered_at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }),
            status: p.status,
            lat: p.latitude || undefined,
            lng: p.longitude || undefined
          };
        });
        setAlerts(mappedAlerts);
      }

      // 3. Fetch real incidents
      const { data: incData } = await supabase
        .from('incidents')
        .select('id, incident_type, severity, description, status, reported_at, supervisor_notes, profiles(first_name, last_name)')
        .eq('site_id', siteId)
        .order('reported_at', { ascending: false })
        .limit(20);

      if (incData) {
        const mappedInc: LiveIncident[] = incData.map((i) => {
          const prof = i.profiles as unknown as { first_name?: string; last_name?: string } | null;
          return {
            id: i.id,
            guardName: prof ? `${prof.first_name || ''} ${prof.last_name || ''}`.trim() : 'Guard',
            type: i.incident_type,
            severity: i.severity,
            description: i.description || 'No description provided',
            time: new Date(i.reported_at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }),
            status: i.status,
            notes: i.supervisor_notes || undefined
          };
        });
        setIncidents(mappedInc);
      }

      // 4. Fetch checkpoints & today's scans for real compliance
      const { data: cpsData } = await supabase
        .from('checkpoints')
        .select('*')
        .eq('site_id', siteId)
        .order('order_index');

      const today = new Date().toISOString().split('T')[0];
      const { data: todayScans } = await supabase
        .from('patrol_scans')
        .select('checkpoint_id, scan_timestamp_device')
        .gte('scan_timestamp_device', `${today}T00:00:00Z`);

      const scanMap: Record<string, string> = {};
      (todayScans || []).forEach((s) => {
        scanMap[s.checkpoint_id] = new Date(s.scan_timestamp_device).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
      });

      if (cpsData) {
        const mappedCps: LiveCheckpoint[] = cpsData.map((c) => ({
          id: c.id,
          name: c.name,
          lat: c.latitude || undefined,
          lng: c.longitude || undefined,
          lastScanned: scanMap[c.id] || 'Pending',
          status: scanMap[c.id] ? 'scanned' : 'pending'
        }));
        setCheckpointsList(mappedCps);

        const scannedCount = Object.keys(scanMap).length;
        const total = cpsData.length || 1;
        setComplianceRate(Math.min(100, Math.round((scannedCount / total) * 100)));
      }

      // 5. Fetch Gate Activity
      const { data: gateData } = await supabase
        .from('gate_entries')
        .select('*')
        .eq('site_id', siteId)
        .order('entry_time', { ascending: false })
        .limit(15);

      if (gateData) {
        const mappedGate: LiveGateEntry[] = gateData.map((g) => ({
          id: g.id,
          plate: g.license_plate,
          vehicle: `${g.make_model || ''} (${g.vehicle_colour || ''})`.trim() || 'Vehicle',
          driver: g.driver_name || undefined,
          dir: g.direction,
          time: new Date(g.entry_time).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }),
          purpose: g.visit_reason || g.company || undefined,
          dwell: g.dwell_duration_seconds ? `${Math.round(g.dwell_duration_seconds / 60)} min` : undefined
        }));
        setGateActivity(mappedGate);
      }
    } catch (err) {
      console.warn('Live data fetch error:', err);
    }
  }, [supabase, siteId, siteName]);

  // Initial load and Realtime subscriptions
  useEffect(() => {
    let isMounted = true;
    const timer = setTimeout(() => {
      if (isMounted) void loadOperationsData();
    }, 0);

    // Setup Supabase Realtime channel
    const channel = supabase
      .channel('supervisor-ops-channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patrol_scans' }, () => {
        void loadOperationsData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'panic_alerts' }, () => {
        void loadOperationsData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, () => {
        void loadOperationsData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gate_entries' }, () => {
        void loadOperationsData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, () => {
        void loadOperationsData();
      })
      .subscribe();

    return () => {
      isMounted = false;
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [supabase, loadOperationsData]);

  // Real Database Alert Acknowledgement
  const handleAcknowledgeAlert = async (alertId: string) => {
    try {
      await supabase
        .from('panic_alerts')
        .update({
          status: 'acknowledged',
          acknowledged_by: user?.id || null,
          acknowledged_at: new Date().toISOString()
        })
        .eq('id', alertId);

      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, status: 'acknowledged' } : a))
      );
    } catch (err) {
      console.error('Failed to acknowledge alert in database:', err);
    }
  };

  // Real Database Incident Note & Acknowledgement
  const handleSaveNote = async (incId: string) => {
    const note = supervisorNote[incId];
    if (!note) return;

    try {
      await supabase
        .from('incidents')
        .update({
          status: 'acknowledged',
          acknowledged_by: user?.id || null,
          acknowledged_at: new Date().toISOString(),
          supervisor_notes: note
        })
        .eq('id', incId);

      setIncidents((prev) =>
        prev.map((i) => (i.id === incId ? { ...i, status: 'acknowledged', notes: note } : i))
      );
    } catch (err) {
      console.error('Failed to save supervisor incident note:', err);
    }
  };

  const activeSosCount = alerts.filter((a) => a.status === 'active').length;

  return (
    <div className="min-h-screen bg-[#18212B] text-[#E9E4D8] flex flex-col font-sans">
        {/* Top Management Navbar */}
        <header className="sticky top-0 z-30 bg-[#18212B]/95 backdrop-blur-md border-b border-[#324050] px-4 py-3">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/guard" className="p-2 rounded-xl bg-[#212C38] border border-[#324050] text-[#9AA5B1] hover:text-[#E9E4D8]">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div className="relative w-9 h-9 rounded-xl overflow-hidden border border-[#F0A53A]/70 flex-none bg-[#18212B]">
                <Image
                  src="/Eagle_Eye_Logo.jpg"
                  alt="Eagle Eye"
                  fill
                  className="object-cover"
                />
              </div>
              <div>
                <h1 className="text-base sm:text-lg font-bold text-[#E9E4D8] tracking-tight flex items-center gap-2">
                  <span>Supervisor Operations Command</span>
                  <span className="w-2.5 h-2.5 rounded-full bg-[#76C08F] animate-pulse" />
                </h1>
                <p className="text-xs text-[#9AA5B1]">
                  {siteName} · Control Room (Realtime Active)
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadOperationsData()}
                className="text-xs text-[#9AA5B1] hover:text-[#E9E4D8] gap-1"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Refresh</span>
              </Button>

              <Link href="/viewer">
                <Button variant="secondary" size="sm" className="hidden sm:inline-flex text-xs">
                  Client Viewer
                </Button>
              </Link>

              <Link href="/admin">
                <Button variant="primary" size="sm" className="text-xs font-bold">
                  Admin Portal
                </Button>
              </Link>

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

        {/* Main Content Area */}
        <main className="flex-1 max-w-6xl mx-auto w-full p-4 space-y-6">
          {/* Top Live Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Guards On Duty"
              value={guards.length.toString()}
              subValue="Real active shifts"
              variant={guards.length > 0 ? 'success' : 'default'}
            />
            <MetricCard
              label="Patrol Compliance"
              value={`${complianceRate}%`}
              subValue="Checkpoints scanned today"
              variant={complianceRate >= 80 ? 'success' : 'warning'}
            />
            <MetricCard
              label="Active SOS Panic"
              value={activeSosCount.toString()}
              subValue={activeSosCount > 0 ? 'Immediate action required' : 'All clear'}
              variant={activeSosCount > 0 ? 'danger' : 'success'}
            />
            <MetricCard
              label="Vehicles Logged"
              value={gateActivity.length.toString()}
              subValue="Gate entries recorded"
              variant="info"
            />
          </div>

          {/* Navigation Tabs */}
          <div className="flex overflow-x-auto gap-2 border-b border-slate-800 pb-2 text-xs font-bold scrollbar-none">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-4 py-2 rounded-xl transition-all ${
                activeTab === 'overview'
                  ? 'bg-[#F0A53A] text-[#2A1A04] shadow-md font-bold'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              Overview & Alerts
            </button>
            <button
              onClick={() => setActiveTab('patrols')}
              className={`px-4 py-2 rounded-xl transition-all ${
                activeTab === 'patrols'
                  ? 'bg-[#F0A53A] text-[#2A1A04] shadow-md font-bold'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              Checkpoints ({checkpointsList.length})
            </button>
            <button
              onClick={() => setActiveTab('incidents')}
              className={`px-4 py-2 rounded-xl transition-all ${
                activeTab === 'incidents'
                  ? 'bg-[#F0A53A] text-[#2A1A04] shadow-md font-bold'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              Incidents ({incidents.length})
            </button>
            <button
              onClick={() => setActiveTab('gate')}
              className={`px-4 py-2 rounded-xl transition-all ${
                activeTab === 'gate'
                  ? 'bg-[#F0A53A] text-[#2A1A04] shadow-md font-bold'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              Gate Logs ({gateActivity.length})
            </button>
          </div>

          {/* Tab 1: Overview & Alerts */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Critical Alerts Banner */}
              {alerts.length > 0 && (
                <Card className="p-4 bg-rose-950/40 border-rose-900/60 rounded-3xl space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ShieldAlert className="w-5 h-5 text-rose-400 animate-bounce" />
                      <h2 className="text-sm font-black text-rose-200 uppercase tracking-wider">
                        Live SOS & Emergency Alerts
                      </h2>
                    </div>
                    <Badge variant="danger">{alerts.length} Reported</Badge>
                  </div>

                  <div className="space-y-2">
                    {alerts.map((alt) => (
                      <div
                        key={alt.id}
                        className="p-3.5 rounded-2xl bg-slate-950/80 border border-rose-900/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white text-xs">{alt.guardName}</span>
                            <span className="text-[11px] font-mono text-slate-400">· {alt.time}</span>
                            {alt.status === 'acknowledged' ? (
                              <Badge variant="success">Acknowledged</Badge>
                            ) : (
                              <Badge variant="danger">ACTIVE SOS</Badge>
                            )}
                          </div>
                          <p className="text-xs text-rose-200 font-semibold">{alt.message}</p>
                          {alt.lat && alt.lng && (
                            <p className="text-[11px] font-mono text-slate-400">
                              Coordinates: {alt.lat.toFixed(5)}, {alt.lng.toFixed(5)}
                            </p>
                          )}
                        </div>

                        {alt.status === 'active' && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => void handleAcknowledgeAlert(alt.id)}
                            className="text-xs font-bold shrink-0"
                          >
                            <Check className="w-3.5 h-3.5 mr-1" />
                            Acknowledge in DB
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Guards On Duty */}
              <div className="space-y-3">
                <h2 className="text-sm font-black text-slate-300 uppercase tracking-wider">
                  Guards on Duty (Live Shifts)
                </h2>

                {guards.length === 0 ? (
                  <Card className="p-6 text-center text-slate-400 text-xs">
                    No active guard shifts currently on duty. Guards clock in via the Guard Home page.
                  </Card>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {guards.map((g) => (
                      <Card key={g.id} className="p-4 bg-slate-900/90 border-slate-800 rounded-2xl space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-sm text-white">{g.name}</span>
                          <Badge variant="success">On Duty</Badge>
                        </div>
                        <div className="text-xs text-slate-400 space-y-1">
                          <p>Site: <span className="text-slate-200">{g.site}</span></p>
                          <p>Shift Started: <span className="text-slate-200 font-mono">{g.shiftStart}</span></p>
                        </div>
                        {g.phone && (
                          <a
                            href={`tel:${g.phone}`}
                            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F0A53A] hover:text-[#FFC76A] pt-1"
                          >
                            <PhoneCall className="w-3.5 h-3.5" />
                            <span>Call Guard ({g.phone})</span>
                          </a>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 2: Checkpoints */}
          {activeTab === 'patrols' && (
            <div className="space-y-3">
              <h2 className="text-sm font-black text-slate-300 uppercase tracking-wider">
                Site Patrol Checkpoints ({checkpointsList.length})
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {checkpointsList.map((cp) => (
                  <Card key={cp.id} className="p-4 bg-slate-900 border-slate-800 rounded-2xl flex items-center justify-between">
                    <div>
                      <span className="font-bold text-sm text-white block">{cp.name}</span>
                      <span className="text-xs text-slate-400">
                        Today&apos;s Last Scan: <span className="font-mono text-slate-300">{cp.lastScanned}</span>
                      </span>
                    </div>
                    {cp.status === 'scanned' ? (
                      <Badge variant="success">Scanned</Badge>
                    ) : (
                      <Badge variant="neutral">Pending</Badge>
                    )}
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Tab 3: Incidents */}
          {activeTab === 'incidents' && (
            <div className="space-y-3">
              <h2 className="text-sm font-black text-slate-300 uppercase tracking-wider">
                Reported Incidents ({incidents.length})
              </h2>

              {incidents.length === 0 ? (
                <Card className="p-6 text-center text-slate-400 text-xs">
                  No incidents recorded for this site.
                </Card>
              ) : (
                <div className="space-y-3">
                  {incidents.map((inc) => (
                    <Card key={inc.id} className="p-4 bg-slate-900 border-slate-800 rounded-2xl space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white text-sm">{inc.type}</span>
                          <Badge variant={inc.severity === 'critical' || inc.severity === 'high' ? 'danger' : 'warning'}>
                            {inc.severity}
                          </Badge>
                        </div>
                        <span className="text-xs font-mono text-slate-400">{inc.time}</span>
                      </div>

                      <p className="text-xs text-slate-300 leading-relaxed">{inc.description}</p>
                      <p className="text-[11px] text-slate-400">Reported by: <span className="text-slate-200">{inc.guardName}</span></p>

                      {inc.notes && (
                        <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-emerald-300">
                          <span className="font-bold block">Supervisor Resolution:</span>
                          {inc.notes}
                        </div>
                      )}

                      {inc.status === 'reported' && (
                        <div className="flex items-center gap-2 pt-1">
                          <input
                            type="text"
                            placeholder="Add resolution notes..."
                            value={supervisorNote[inc.id] || ''}
                            onChange={(e) => setSupervisorNote({ ...supervisorNote, [inc.id]: e.target.value })}
                            className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-white"
                          />
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void handleSaveNote(inc.id)}
                            className="text-xs"
                          >
                            Resolve in DB
                          </Button>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Tab 4: Gate Activity */}
          {activeTab === 'gate' && (
            <div className="space-y-3">
              <h2 className="text-sm font-black text-slate-300 uppercase tracking-wider">
                Vehicle Access Log ({gateActivity.length})
              </h2>

              {gateActivity.length === 0 ? (
                <Card className="p-6 text-center text-slate-400 text-xs">
                  No gate entries recorded yet.
                </Card>
              ) : (
                <div className="space-y-2">
                  {gateActivity.map((g) => (
                    <Card key={g.id} className="p-3.5 bg-slate-900 border-slate-800 rounded-2xl flex items-center justify-between text-xs">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-white">{g.plate}</span>
                          <Badge variant={g.dir === 'in' ? 'success' : 'neutral'}>
                            {g.dir.toUpperCase()}
                          </Badge>
                          {g.dwell && <span className="text-[11px] text-slate-400">Dwell: {g.dwell}</span>}
                        </div>
                        <p className="text-slate-400 mt-0.5">{g.vehicle} {g.driver ? `· Driver: ${g.driver}` : ''}</p>
                      </div>
                      <span className="font-mono text-slate-400">{g.time}</span>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
  );
}
