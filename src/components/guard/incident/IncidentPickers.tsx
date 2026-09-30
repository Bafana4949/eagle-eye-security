'use client';

import React, { forwardRef } from 'react';
import { CircleHelp, DoorOpen, Fence, Flame, PawPrint, UserX, type LucideIcon } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { IncidentSeverity } from '@/types/models';
import { INCIDENT_SEVERITIES, INCIDENT_TYPES, incidentTypeLabel, severityLabel, type IncidentTypeId } from './incidentLogic';

const TYPE_ICONS: Record<IncidentTypeId, LucideIcon> = {
  fence: Fence,
  gate: DoorOpen,
  stock: PawPrint,
  person: UserX,
  fire: Flame,
  other: CircleHelp
};

interface IncidentTypePickerProps {
  value: IncidentTypeId | null;
  onChange: (type: IncidentTypeId) => void;
  labelId: string;
  disabled?: boolean;
  invalid?: boolean;
}

/** The six reference incident types as large toggle buttons. The ref goes to the first button. */
export const IncidentTypePicker = forwardRef<HTMLButtonElement, IncidentTypePickerProps>(function IncidentTypePicker(
  { value, onChange, labelId, disabled = false, invalid = false },
  firstRef
) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-labelledby={labelId} className="grid grid-cols-2 gap-2">
      {INCIDENT_TYPES.map((type, index) => {
        const Icon = TYPE_ICONS[type];
        const selected = value === type;
        return (
          <button
            key={type}
            ref={index === 0 ? firstRef : undefined}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(type)}
            data-testid={`incident-type-${type}`}
            className={`flex min-h-16 items-center gap-2 rounded-xl border-2 px-3 py-2 text-left text-sm font-semibold leading-tight disabled:opacity-50 ${
              selected
                ? 'border-ee-primary bg-ee-primary/15 text-ee-text'
                : invalid
                  ? 'border-ee-danger/60 bg-ee-bg text-ee-text hover:bg-ee-surface-raised'
                  : 'border-ee-border bg-ee-bg text-ee-text hover:bg-ee-surface-raised'
            }`}
          >
            <Icon className={`h-6 w-6 shrink-0 ${selected ? 'text-ee-primary' : 'text-ee-muted'}`} aria-hidden="true" />
            <span className="min-w-0 break-words">{incidentTypeLabel(type, t)}</span>
          </button>
        );
      })}
    </div>
  );
});

const SEVERITY_SELECTED: Record<IncidentSeverity, string> = {
  low: 'border-ee-muted bg-ee-surface-raised text-ee-text',
  medium: 'border-ee-warning bg-ee-warning/15 text-ee-text',
  high: 'border-ee-danger bg-ee-danger/15 text-ee-text',
  critical: 'border-ee-danger bg-ee-danger text-ee-on-danger'
};

interface SeverityPickerProps {
  value: IncidentSeverity;
  onChange: (severity: IncidentSeverity) => void;
  labelId: string;
  disabled?: boolean;
}

export function SeverityPicker({ value, onChange, labelId, disabled = false }: SeverityPickerProps) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-labelledby={labelId} className="grid grid-cols-2 gap-2">
      {INCIDENT_SEVERITIES.map((level) => {
        const selected = value === level;
        return (
          <button
            key={level}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(level)}
            data-testid={`incident-severity-${level}`}
            className={`min-h-12 rounded-xl border-2 px-2 text-base font-semibold disabled:opacity-50 ${
              selected ? SEVERITY_SELECTED[level] : 'border-ee-border bg-ee-bg text-ee-muted hover:bg-ee-surface-raised'
            }`}
          >
            {severityLabel(level, t)}
          </button>
        );
      })}
    </div>
  );
}
