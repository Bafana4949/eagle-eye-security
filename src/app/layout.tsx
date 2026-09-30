import type { Metadata, Viewport } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import { PwaRegistrar } from "@/components/shared/PwaRegistrar";
import { AuthProvider } from "@/context/AuthContext";
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

export const viewport: Viewport = {
  themeColor: "#18212B",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover"
};

export const metadata: Metadata = {
  title: "Eagle Eye - Security Operations & Patrol System",
  description: "Mobile-first security patrol management, gate access control, GPS verification and incident reporting system for Aiguille Security & Dawie Boerdery.",
  manifest: "/manifest.json",
  icons: {
    icon: "/Eagle_Eye_Logo.jpg",
    apple: "/Eagle_Eye_Logo.jpg",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Eagle Eye"
  }
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${barlow.variable} ${barlowCondensed.variable} h-full antialiased bg-[#18212B] text-[#E9E4D8]`}
    >
      <body className="min-h-full flex flex-col bg-[#18212B] text-[#E9E4D8]">
        <PwaRegistrar />
        <I18nProvider>
          <AuthProvider>{children}</AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
