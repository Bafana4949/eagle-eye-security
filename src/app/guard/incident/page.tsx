'use client';

import React, { useState } from 'react';
import { 
  AlertTriangle, 
  Camera, 
  Send, 
  CheckCircle2, 
  Flame, 
  Lock, 
  UserX, 
  ShieldAlert, 
  HeartPulse,
  Navigation,
  ArrowRight
} from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CameraCaptureModal } from '@/components/shared/CameraCaptureModal';
import { offlineDB } from '@/lib/offline/db';
import { syncEngine } from '@/lib/offline/sync';
import { Incident, IncidentSeverity } from '@/types/models';

interface SubmittedIncidentInfo {
  reference: string;
  isOnline: boolean;
  type: string;
  timestamp: string;
}

export default function GuardIncidentPage() {
  const { t } = useTranslation();

  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [severity, setSeverity] = useState<IncidentSeverity>('medium');
  const [description, setDescription] = useState('');
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [submittedInfo, setSubmittedInfo] = useState<SubmittedIncidentInfo | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const guardId = '55555555-5555-5555-5555-555555555555';
  const siteId = '22222222-2222-2222-2222-222222222222';
  const guardName = 'Sipho Khoza';

  const incidentCategories = [
    { id: 'fence', label: t('incFence'), icon: ShieldAlert },
    { id: 'gate', label: t('incGate'), icon: Lock },
    { id: 'person', label: t('incPerson'), icon: UserX },
    { id: 'fire', label: t('incFire'), icon: Flame },
    { id: 'stock', label: t('incStock'), icon: AlertTriangle },
    { id: 'theft', label: t('incTheft'), icon: ShieldAlert },
    { id: 'medical', label: t('incMedical'), icon: HeartPulse },
    { id: 'other', label: t('incOther'), icon: AlertTriangle }
  ];

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const handleSubmit = async () => {
    if (!selectedType) {
      showToast('Please select what type of incident happened');
      return;
    }

    setIsSubmitting(true);

    let lat: number | undefined;
    let lon: number | undefined;

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, {
            enableHighAccuracy: true,
            timeout: 5000
          })
        );
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
      } catch {
        // Geolocation fallback
      }
    }

    const nowIso = new Date().toISOString();
    const offlineId = crypto.randomUUID();
    const randomSeq = Math.floor(100000 + Math.random() * 900000);
    const reference = `INC-2026-${randomSeq}`;

    const incidentRecord: Incident = {
      id: offlineId,
      offlineUuid: offlineId,
      siteId,
      guardId,
      guardName,
      incidentType: selectedType,
      severity,
      description: description.trim(),
      latitude: lat,
      longitude: lon,
      status: 'reported',
      reportedAt: nowIso,
      photos: photoUrl ? [photoUrl] : []
    };

    if (offlineDB) {
      await offlineDB.incidents.add(incidentRecord);
    }

    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

    if (syncEngine) {
      const mediaList = photoBlob
        ? [{ field: 'photo', blob: photoBlob, fileName: 'incident.jpg', mimeType: 'image/jpeg' }]
        : undefined;

      await syncEngine.enqueue(
        'incident',
        guardId,
        siteId,
        {
          referenceNumber: reference,
          incidentType: selectedType,
          severity,
          description: description.trim(),
          latitude: lat,
          longitude: lon,
          status: 'reported'
        },
        mediaList
      );
    }

    setIsSubmitting(false);
    setSubmittedInfo({
      reference,
      isOnline,
      type: selectedType.toUpperCase(),
      timestamp: new Date().toLocaleTimeString('en-ZA', { hour12: false })
    });

    // Reset Form
    setSelectedType(null);
    setDescription('');
    setPhotoBlob(null);
    setPhotoUrl(null);
  };

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-6">
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed top-16 left-4 right-4 z-50 p-3.5 bg-blue-600 text-white font-bold text-xs rounded-xl shadow-2xl text-center animate-in slide-in-from-top-4 duration-200">
          {toastMessage}
        </div>
      )}

      {/* Confirmation Screen after Submission */}
      {submittedInfo ? (
        <Card className="p-6 text-center border-emerald-500/80 bg-slate-900/90 rounded-3xl animate-in zoom-in-95 duration-150">
          <div className="w-16 h-16 rounded-full bg-emerald-950/90 border-2 border-emerald-400 flex items-center justify-center mx-auto mb-4 text-emerald-400">
            <CheckCircle2 className="w-10 h-10" />
          </div>

          <span className="text-[11px] font-extrabold uppercase tracking-widest text-emerald-400 block mb-1">
            INCIDENT REPORTED
          </span>
          <h2 className="text-xl font-black text-white tracking-tight mb-2">
            Reference: {submittedInfo.reference}
          </h2>

          <div className="bg-slate-950/80 rounded-2xl p-4 border border-slate-800 text-xs font-mono text-slate-300 space-y-1.5 my-4">
            <div className="flex justify-between">
              <span className="text-slate-500">Report Time:</span>
              <span className="font-bold text-white">{submittedInfo.timestamp}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Classification:</span>
              <span className="font-bold text-amber-400">{submittedInfo.type}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Cloud Sync:</span>
              <span className={`font-bold ${submittedInfo.isOnline ? 'text-emerald-400' : 'text-amber-400'}`}>
                {submittedInfo.isOnline ? 'Uploaded to Server' : 'Queued (Waiting for connection)'}
              </span>
            </div>
          </div>

          <Button
            onClick={() => setSubmittedInfo(null)}
            variant="primary"
            size="touch"
            className="w-full bg-blue-600 hover:bg-blue-500 font-bold"
          >
            <span>Report Another Incident</span>
            <ArrowRight className="w-5 h-5 ml-1" />
          </Button>
        </Card>
      ) : (
        /* Incident Creation Form */
        <Card className="rounded-3xl border-slate-800 bg-slate-900/90 p-4">
          <CardHeader className="mb-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <CardTitle>Report Security Incident</CardTitle>
            </div>
            <Badge variant="warning">{t('incidentType')}</Badge>
          </CardHeader>

          {/* Categories Grid (Step 1) */}
          <div className="grid grid-cols-2 gap-2.5 mt-2">
            {incidentCategories.map((cat) => {
              const Icon = cat.icon;
              const isSelected = selectedType === cat.id;

              return (
                <button
                  key={cat.id}
                  onClick={() => setSelectedType(cat.id)}
                  className={`p-3.5 rounded-2xl border text-left flex items-center gap-2.5 transition-all select-none active:scale-[0.98] ${
                    isSelected
                      ? 'bg-amber-950/70 border-amber-400 text-amber-200 font-bold shadow-lg shadow-amber-950/40'
                      : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <Icon className={`w-5 h-5 flex-shrink-0 ${isSelected ? 'text-amber-400' : 'text-slate-500'}`} />
                  <span className="text-xs leading-tight">{cat.label}</span>
                </button>
              );
            })}
          </div>

          {/* Severity Selector (Step 2) */}
          <div className="mt-4 pt-3 border-t border-slate-800">
            <label className="text-xs font-bold text-slate-400 block mb-2">
              Incident Severity
            </label>
            <div className="grid grid-cols-4 gap-2">
              {(['low', 'medium', 'high', 'critical'] as IncidentSeverity[]).map((level) => {
                const isSelected = severity === level;
                const colors = {
                  low: isSelected ? 'bg-blue-600 text-white' : 'bg-slate-950 border border-slate-800 text-slate-400',
                  medium: isSelected ? 'bg-amber-600 text-white' : 'bg-slate-950 border border-slate-800 text-slate-400',
                  high: isSelected ? 'bg-orange-600 text-white' : 'bg-slate-950 border border-slate-800 text-slate-400',
                  critical: isSelected ? 'bg-rose-600 text-white' : 'bg-slate-950 border border-slate-800 text-slate-400'
                };

                return (
                  <button
                    key={level}
                    onClick={() => setSeverity(level)}
                    className={`py-2 px-1 text-xs font-bold rounded-xl uppercase tracking-wider transition-all ${colors[level]}`}
                  >
                    {level}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Description Field (Step 3) */}
          <div className="mt-4">
            <label className="text-xs font-bold text-slate-400 block mb-1">
              Incident Description / Location Details
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={300}
              placeholder="e.g. South boundary fence wire cut near river bed. Footprints heading towards main road."
              className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-xs text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Evidence Photo (Step 4) */}
          <div className="mt-3">
            {photoUrl ? (
              <div className="flex items-center gap-3 p-2.5 rounded-2xl bg-slate-950 border border-slate-800">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoUrl} alt="Evidence preview" className="w-12 h-12 object-cover rounded-xl" />
                <div className="flex-1">
                  <span className="text-xs font-bold text-emerald-400 block">Photograph Attached</span>
                  <button
                    onClick={() => {
                      setPhotoUrl(null);
                      setPhotoBlob(null);
                    }}
                    className="text-[11px] text-rose-400 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowPhotoModal(true)}
                className="w-full py-3.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-bold flex items-center justify-center gap-2"
              >
                <Camera className="w-5 h-5 text-blue-400" />
                <span>Take Evidence Photo</span>
              </button>
            )}
          </div>

          {/* GPS Auto-tag note (Step 5) */}
          <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-400 px-1">
            <Navigation className="w-3.5 h-3.5 text-emerald-400" />
            <span>GPS location will be automatically tagged upon submission</span>
          </div>

          {/* Submit Action (Step 6) */}
          <div className="pt-4">
            <Button
              onClick={() => void handleSubmit()}
              variant="primary"
              size="touch"
              isLoading={isSubmitting}
              className="w-full gap-2 bg-gradient-to-r from-amber-600 to-rose-600 hover:from-amber-500 hover:to-rose-500 font-bold shadow-xl shadow-amber-950/60"
            >
              <Send className="w-5 h-5" />
              <span>Submit Incident Report</span>
            </Button>
          </div>
        </Card>
      )}

      {/* Camera Capture Modal */}
      <CameraCaptureModal
        isOpen={showPhotoModal}
        onClose={() => setShowPhotoModal(false)}
        onCapture={(blob, url) => {
          setPhotoBlob(blob);
          setPhotoUrl(url);
          setShowPhotoModal(false);
        }}
        title="Incident Evidence Photo"
      />
    </div>
  );
}
