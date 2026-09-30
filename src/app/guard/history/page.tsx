'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Clock, MapPin } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/lib/i18n/context';
import { offlineDB } from '@/lib/offline/db';
import { PatrolScan, Shift } from '@/types/models';
import { formatTimeHM } from '@/features/shifts/shiftCalculator';
import { formatDistance } from '@/lib/gps/haversine';

export default function GuardHistoryPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'scans' | 'shifts'>('scans');
  const [scans, setScans] = useState<PatrolScan[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);

  useEffect(() => {
    const loadLogs = async () => {
      if (offlineDB) {
        const scanRecords = await offlineDB.scans.reverse().limit(50).toArray();
        setScans(scanRecords);

        const shiftRecords = await offlineDB.shifts.reverse().limit(20).toArray();
        setShifts(shiftRecords);
      }
    };

    void loadLogs();
  }, []);

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/guard" className="p-2.5 rounded-2xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h2 className="text-xl font-black text-white tracking-tight">{t('history')}</h2>
          <p className="text-xs text-slate-400">Local audit log of scans and duty shifts</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-2 gap-2 p-1.5 rounded-2xl bg-slate-900 border border-slate-800">
        <button
          onClick={() => setActiveTab('scans')}
          className={`py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all ${
            activeTab === 'scans' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400'
          }`}
        >
          <MapPin className="w-4 h-4" />
          <span>{t('recentScans')} ({scans.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('shifts')}
          className={`py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all ${
            activeTab === 'shifts' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>Shifts Log ({shifts.length})</span>
        </button>
      </div>

      {/* Tab Content: Scans */}
      {activeTab === 'scans' && (
        <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
          {scans.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-8">{t('noScans') || 'No scans recorded yet'}</p>
          ) : (
            <div className="space-y-3">
              {scans.map((scan) => (
                <div key={scan.id} className="p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800 flex items-center justify-between gap-3">
                  <div>
                    <span className="text-sm font-bold text-white block">{scan.checkpointName}</span>
                    <span className="text-[11px] font-mono text-slate-400">
                      {formatTimeHM(scan.scanTimestampDevice)} · GPS ±{scan.accuracyMeters || 10}m
                    </span>
                    {scan.distanceToCheckpointMeters != null && (
                      <span className="text-[11px] text-slate-500 block mt-0.5">
                        Distance: {formatDistance(scan.distanceToCheckpointMeters)}
                      </span>
                    )}
                  </div>
                  <Badge variant={scan.isValidProximity ? 'success' : 'danger'}>
                    {scan.isValidProximity ? 'Verified' : 'Out of Range'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Tab Content: Shifts */}
      {activeTab === 'shifts' && (
        <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
          {shifts.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-8">No shifts recorded yet</p>
          ) : (
            <div className="space-y-3">
              {shifts.map((shift) => (
                <div key={shift.id} className="p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800 flex items-center justify-between gap-3">
                  <div>
                    <span className="text-sm font-bold text-white block">
                      {shift.shiftType === 'day' ? '☀️ Day Shift' : '🌙 Night Shift'}
                    </span>
                    <span className="text-[11px] font-mono text-slate-400">
                      {formatTimeHM(shift.actualStart || shift.scheduledStart)} – {shift.actualEnd ? formatTimeHM(shift.actualEnd) : 'Active'}
                    </span>
                  </div>
                  <Badge variant={shift.status === 'completed' ? 'neutral' : 'success'}>
                    {shift.status.toUpperCase()}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
