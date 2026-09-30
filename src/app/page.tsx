import React from 'react';
import Link from 'next/link';
import { 
  ShieldCheck, 
  Smartphone, 
  Monitor, 
  Building2, 
  Lock,
  ArrowRight,
  Eye
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export default function LandingPortalPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between p-4 md:p-8 selection:bg-blue-600 selection:text-white">
      {/* Top Brand Header */}
      <header className="max-w-5xl mx-auto w-full flex items-center justify-between py-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-700 to-indigo-500 flex items-center justify-center shadow-xl shadow-blue-900/40 border border-blue-400/30">
            <ShieldCheck className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-black text-white tracking-tight leading-none">
              EAGLE EYE
            </h1>
            <p className="text-xs text-blue-400 font-semibold tracking-wide uppercase mt-0.5">
              Aiguille Security & Farm Operations
            </p>
          </div>
        </div>

        <Link href="/login">
          <Button variant="outline" size="sm" className="gap-2">
            <Lock className="w-3.5 h-3.5 text-blue-400" />
            <span>Sign In</span>
          </Button>
        </Link>
      </header>

      {/* Hero Section */}
      <main className="max-w-5xl mx-auto w-full my-auto py-8 space-y-8">
        <div className="text-center space-y-3">
          <Badge variant="info" className="px-3 py-1">
            Production Security Operations Platform
          </Badge>
          <h2 className="text-3xl md:text-5xl font-black text-white tracking-tight leading-tight">
            Mobile-First Guard Patrols & Command Operations
          </h2>
          <p className="text-base text-slate-400 max-w-2xl mx-auto">
            Offline-first security operations with GPS proximity validation, QR & Web NFC scanning, 
            South African vehicle disc decoding, incident photography, and real-time supervisor command.
          </p>
        </div>

        {/* Portal Cards Grid (4 Portals: Guard, Supervisor, Admin, Client Viewer) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* 1. Guard Mobile App */}
          <Link href="/guard" className="group">
            <Card className="h-full p-5 border-slate-800 hover:border-blue-500/80 bg-slate-900/90 group-hover:bg-slate-900 transition-all shadow-xl group-hover:shadow-blue-950/30 flex flex-col justify-between rounded-3xl">
              <div>
                <div className="w-11 h-11 rounded-2xl bg-blue-950 border border-blue-700 flex items-center justify-center text-blue-400 mb-3 group-hover:scale-105 transition-transform">
                  <Smartphone className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-bold text-white mb-1.5 flex items-center gap-1.5">
                  <span>Guard App</span>
                  <Badge variant="success">PWA</Badge>
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Touch-first interface for security guards. Clock in with selfie, scan checkpoints, capture GPS, log vehicle entry & exit, and trigger SOS.
                </p>
              </div>

              <div className="mt-5 pt-3 border-t border-slate-800 flex items-center justify-between text-blue-400 text-xs font-bold">
                <span>Launch Guard</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </div>
            </Card>
          </Link>

          {/* 2. Supervisor Operations Center */}
          <Link href="/supervisor" className="group">
            <Card className="h-full p-5 border-slate-800 hover:border-indigo-500/80 bg-slate-900/90 group-hover:bg-slate-900 transition-all shadow-xl group-hover:shadow-indigo-950/30 flex flex-col justify-between rounded-3xl">
              <div>
                <div className="w-11 h-11 rounded-2xl bg-indigo-950 border border-indigo-700 flex items-center justify-center text-indigo-400 mb-3 group-hover:scale-105 transition-transform">
                  <Monitor className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-bold text-white mb-1.5 flex items-center gap-1.5">
                  <span>Supervisor</span>
                  <Badge variant="info">Live</Badge>
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Real-time command center for supervisors. Monitor on-duty guards, detect overdue patrols, acknowledge emergency SOS alerts, and review incidents.
                </p>
              </div>

              <div className="mt-5 pt-3 border-t border-slate-800 flex items-center justify-between text-indigo-400 text-xs font-bold">
                <span>Open Command</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </div>
            </Card>
          </Link>

          {/* 3. Administration & Checkpoint Setup */}
          <Link href="/admin" className="group">
            <Card className="h-full p-5 border-slate-800 hover:border-emerald-500/80 bg-slate-900/90 group-hover:bg-slate-900 transition-all shadow-xl group-hover:shadow-emerald-950/30 flex flex-col justify-between rounded-3xl">
              <div>
                <div className="w-11 h-11 rounded-2xl bg-emerald-950 border border-emerald-700 flex items-center justify-center text-emerald-400 mb-3 group-hover:scale-105 transition-transform">
                  <Building2 className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-white mb-1.5 flex items-center gap-1.5">
                  <span>Admin</span>
                  <Badge variant="neutral">Setup</Badge>
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Configure site coordinates, shift hours, and round intervals. Generate secure QR codes, print checkpoint cards, and export compliance CSV reports.
                </p>
              </div>

              <div className="mt-5 pt-3 border-t border-slate-800 flex items-center justify-between text-emerald-400 text-xs font-bold">
                <span>Manage Settings</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </div>
            </Card>
          </Link>

          {/* 4. Client Viewer Portal */}
          <Link href="/viewer" className="group">
            <Card className="h-full p-5 border-slate-800 hover:border-amber-500/80 bg-slate-900/90 group-hover:bg-slate-900 transition-all shadow-xl group-hover:shadow-amber-950/30 flex flex-col justify-between rounded-3xl">
              <div>
                <div className="w-11 h-11 rounded-2xl bg-amber-950 border border-amber-700 flex items-center justify-center text-amber-400 mb-3 group-hover:scale-105 transition-transform">
                  <Eye className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-bold text-white mb-1.5 flex items-center gap-1.5">
                  <span>Client Portal</span>
                  <Badge variant="warning">Viewer</Badge>
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Read-only transparent portal for farm owners and clients to inspect hourly compliance, attendance, incident reports, and print verification summaries.
                </p>
              </div>

              <div className="mt-5 pt-3 border-t border-slate-800 flex items-center justify-between text-amber-400 text-xs font-bold">
                <span>Client View</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </div>
            </Card>
          </Link>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-5xl mx-auto w-full text-center py-4 border-t border-slate-800/80 text-xs text-slate-500 flex flex-col md:flex-row items-center justify-between gap-2">
        <span>Eagle Eye Security Operations &copy; 2026. Built for Aiguille Security & Dawie Boerdery.</span>
        <span>Afrikaans · English · isiZulu</span>
      </footer>
    </div>
  );
}
