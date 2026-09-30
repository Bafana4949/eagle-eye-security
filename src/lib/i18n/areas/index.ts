import { authTranslations } from './auth';
import { guardHomeTranslations } from './guardHome';
import { patrolTranslations } from './patrol';
import { gateTranslations } from './gate';
import { incidentTranslations } from './incident';
import { adminTranslations } from './admin';
import { supervisorTranslations } from './supervisor';
import { pwaTranslations } from './pwa';

export const areaTranslations = {
  en: {
    ...authTranslations.en,
    ...guardHomeTranslations.en,
    ...patrolTranslations.en,
    ...gateTranslations.en,
    ...incidentTranslations.en,
    ...adminTranslations.en,
    ...supervisorTranslations.en,
    ...pwaTranslations.en,
  },
  af: {
    ...authTranslations.af,
    ...guardHomeTranslations.af,
    ...patrolTranslations.af,
    ...gateTranslations.af,
    ...incidentTranslations.af,
    ...adminTranslations.af,
    ...supervisorTranslations.af,
    ...pwaTranslations.af,
  },
  zu: {
    ...authTranslations.zu,
    ...guardHomeTranslations.zu,
    ...patrolTranslations.zu,
    ...gateTranslations.zu,
    ...incidentTranslations.zu,
    ...adminTranslations.zu,
    ...supervisorTranslations.zu,
    ...pwaTranslations.zu,
  },
};
