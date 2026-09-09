import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { NavBar } from "@/components/NavBar";
import { SwAutoReload } from "@/components/SwAutoReload";
import { VersionCheck } from "@/components/VersionCheck";
import { NoticeToast } from "@/components/NoticeToast";
import { ThemeApplier } from "@/components/ThemeSwitcher";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Agent HQ Orchestron",
  description: "Multi-agent orchestration hub",
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
      data-theme="orchestron"
      suppressHydrationWarning
    >
      <head>
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
      </head>
      <body className="h-full flex flex-col overflow-hidden">
        <Providers>
          <ThemeApplier />
          <SwAutoReload />
          <VersionCheck />
          <NoticeToast />
          <NavBar />
          {/* min-h-0 lets flex-1 actually shrink so children using h-full
           *  can resolve a real pixel height regardless of nav row count. */}
          <main className="flex-1 min-h-0 overflow-auto">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
