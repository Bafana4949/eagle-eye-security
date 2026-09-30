// Translations owned by the "pwa" area. Every key added to en must also be added to af and zu
// (enforced by src/lib/i18n/translations.test.ts). Afrikaans / isiZulu wording needs native-speaker review.
// The offline fallback page (public/offline.html) is static HTML and carries its own en/af/zu text.
export const pwaTranslations = {
  en: {
    pwaUpdateAvailable: 'Update available',
    pwaUpdateHint: 'Finish the form you are filling in, then reload. Records already saved on this phone are kept.',
    pwaUpdateReload: 'Reload',
    pwaUpdateReloading: 'Reloading…',
    pwaUpdateLater: 'Later',
    pwaUpdateAppliedElsewhere: 'The app was updated in another window. Reload to use the new version.',
    pwaUpdateAnnouncement: 'Update available. Reload when you are ready.',
  },
  af: {
    pwaUpdateAvailable: 'Opdatering beskikbaar',
    pwaUpdateHint: 'Voltooi eers die vorm wat jy invul, en herlaai dan. Rekords wat reeds op hierdie foon gestoor is, bly behoue.',
    pwaUpdateReload: 'Herlaai',
    pwaUpdateReloading: 'Herlaai tans…',
    pwaUpdateLater: 'Later',
    pwaUpdateAppliedElsewhere: "Die toep is in 'n ander venster opgedateer. Herlaai om die nuwe weergawe te gebruik.",
    pwaUpdateAnnouncement: 'Opdatering beskikbaar. Herlaai wanneer jy gereed is.',
  },
  zu: {
    pwaUpdateAvailable: 'Kukhona isibuyekezo',
    pwaUpdateHint: 'Qeda kuqala ifomu oligcwalisayo, bese uyalayisha kabusha. Amarekhodi asevele egcinwe kule foni azohlala ekhona.',
    pwaUpdateReload: 'Layisha kabusha',
    pwaUpdateReloading: 'Iyalayisha kabusha…',
    pwaUpdateLater: 'Kamuva',
    pwaUpdateAppliedElsewhere: 'Uhlelo lubuyekeziwe kwelinye iwindi. Layisha kabusha ukuze usebenzise inguqulo entsha.',
    pwaUpdateAnnouncement: 'Kukhona isibuyekezo. Layisha kabusha uma usulungile.',
  },
};
