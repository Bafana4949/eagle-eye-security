import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PwaRegistrar } from "@/components/shared/PwaRegistrar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  themeColor: "#0f172a",
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
      lang="af"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased bg-slate-950 text-slate-100`}
    >
      <body className="min-h-full flex flex-col bg-slate-950">
        <PwaRegistrar />
        {children}
      </body>
    </html>
  );
}
