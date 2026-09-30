'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  RefreshCw, 
  Globe, 
  FileSpreadsheet, 
  Download, 
  ExternalLink 
} from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { syncEngine } from '@/lib/offline/sync';
import { offlineDB } from '@/lib/offline/db';
import { OfflineSyncSummary } from '@/types/offline';
import { SupportedLanguage } from '@/types/models';

export default function GuardMorePage() {
  const { language, setLanguage, t } = useTranslation();
  const [syncSummary, setSyncSummary] = useState<OfflineSyncSummary>({
    isOnline: true,
    pendingCount: 0,
    syncingCount: 0,
    failedCount: 0
  });

  useEffect(() => {
    if (syncEngine) {
      const unsub = syncEngine.subscribe(setSyncSummary);
      return unsub;
    }
  }, []);

  const handleManualSync = () => {
    if (syncEngine) {
      void syncEngine.triggerSync();
    }
  };

  const handleExportLocalCSV = async () => {
    if (!offlineDB) return;

    const scans = await offlineDB.scans.toArray();
    if (scans.length === 0) {
      alert('No scan records found in local database');
      return;
    }

    const headers = ['ID', 'Checkpoint', 'Timestamp', 'Accuracy (m)', 'Distance (m)', 'Valid', 'Method'];
    const rows = scans.map((s) => [
      s.id,
      `"${s.checkpointName}"`,
      s.scanTimestampDevice,
      s.accuracyMeters || '',
      s.distanceToCheckpointMeters || '',
      s.isValidProximity ? 'YES' : 'NO',
      s.method
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `eagle_eye_scans_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-6">
      <div className="px-1">
        <h2 className="text-xl font-black text-white tracking-tight">{t('more')} & Operational Settings</h2>
        <p className="text-xs text-slate-400">Device synchronisation, offline cache, and language</p>
      </div>

      {/* Language Selector */}
      <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
        <CardHeader className="mb-2">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-[#F0A53A]" />
            <CardTitle className="text-sm">Language / Taal / Ulimi</CardTitle>
          </div>
          <Badge variant="info">{language.toUpperCase()}</Badge>
        </CardHeader>

        <div className="grid grid-cols-3 gap-2 mt-2">
          {[
            { code: 'af', label: 'Afrikaans', flag: '🇿🇦' },
            { code: 'en', label: 'English', flag: '🇬🇧' },
            { code: 'zu', label: 'isiZulu', flag: '🇿🇦' }
          ].map((lang) => (
            <button
              key={lang.code}
              onClick={() => setLanguage(lang.code as SupportedLanguage)}
              className={`p-3 rounded-2xl border text-center transition-all ${
                language === lang.code
                  ? 'bg-[#F0A53A] border-[#F0A53A] text-[#2A1A04] font-bold shadow-lg'
                  : 'bg-[#18212B] border-[#324050] text-[#9AA5B1] hover:border-[#F0A53A]/50 hover:text-[#E9E4D8]'
              }`}
            >
              <span className="text-lg block mb-0.5">{lang.flag}</span>
              <span className="text-xs font-semibold block">{lang.label}</span>
            </button>
          ))}
        </div>
      </Card>

      {/* Offline Sync Status */}
      <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
        <CardHeader className="mb-2">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5 text-emerald-400" />
            <CardTitle className="text-sm">Offline Cache & Sync Queue</CardTitle>
          </div>
          <Badge variant={syncSummary.isOnline ? 'success' : 'warning'}>
            {syncSummary.isOnline ? 'Connected' : 'Offline'}
          </Badge>
        </CardHeader>

        <div className="space-y-2 text-xs py-2">
          <div className="flex justify-between p-2 rounded-xl bg-slate-950 border border-slate-800">
            <span className="text-slate-400">Records Pending Sync:</span>
            <span className="font-mono font-bold text-white">{syncSummary.pendingCount}</span>
          </div>
          <div className="flex justify-between p-2 rounded-xl bg-slate-950 border border-slate-800">
            <span className="text-slate-400">Failed / Retry Queue:</span>
            <span className="font-mono font-bold text-rose-400">{syncSummary.failedCount}</span>
          </div>
        </div>

        <Button
          onClick={handleManualSync}
          variant="secondary"
          size="touch"
          className="w-full mt-2 gap-2 font-bold"
        >
          <RefreshCw className="w-4 h-4" />
          <span>{t('syncNow')}</span>
        </Button>
      </Card>

      {/* Backup CSV Export */}
      <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
        <CardHeader className="mb-2">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-amber-400" />
            <CardTitle className="text-sm">Offline Evidence Export</CardTitle>
          </div>
        </CardHeader>
        <p className="text-xs text-slate-400 mb-3">
          Download patrol scans stored in your phone&apos;s IndexedDB cache as a CSV spreadsheet.
        </p>
        <Button
          onClick={() => void handleExportLocalCSV()}
          variant="outline"
          size="touch"
          className="w-full gap-2 font-bold text-slate-200 border-slate-700"
        >
          <Download className="w-4 h-4 text-amber-400" />
          <span>Export Local Scans (CSV)</span>
        </Button>
      </Card>

      {/* Portal Links */}
      <div className="space-y-2 pt-2">
        <Link href="/supervisor">
          <div className="p-3.5 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-bold text-slate-200 flex items-center justify-between">
            <span>Supervisor Command Portal</span>
            <ExternalLink className="w-4 h-4 text-[#F0A53A]" />
          </div>
        </Link>
        <Link href="/admin">
          <div className="p-3.5 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-bold text-slate-200 flex items-center justify-between">
            <span>Admin Settings & Checkpoint Generator</span>
            <ExternalLink className="w-4 h-4 text-emerald-400" />
          </div>
        </Link>
      </div>
    </div>
  );
}
