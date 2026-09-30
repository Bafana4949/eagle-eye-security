import type { Metadata, Viewport } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import { PwaRegistrar } from "@/components/shared/PwaRegistrar";
import { AuthProvider } from "@/lib/auth/AuthProvider";
import { I18nProvider } from "@/lib/i18n/context";
import "./globals.css";

const barlow = Barlow({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-barlow",
});

const barlowCondensed = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-barlow-condensed",
});

// Pinch-zoom stays enabled (no maximumScale / userScalable): guards must be able to enlarge text.
export const viewport: Viewport = {
  // Same colour as --color-ee-bg in globals.css (the meta tag needs a literal colour value).
  themeColor: "rgb(24 33 43)",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Eagle Eye Security",
  description: "Guard patrols, gate log, incidents and SOS for Aiguille Security and Dawie Boerdery.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Eagle Eye",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="af"
      className={`${barlow.variable} ${barlowCondensed.variable} h-full antialiased bg-ee-bg text-ee-text`}
    >
      <body className="min-h-full flex flex-col bg-ee-bg text-ee-text font-sans">
        <I18nProvider>
          <AuthProvider>
            <PwaRegistrar />
            {children}
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
