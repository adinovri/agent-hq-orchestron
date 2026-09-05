import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { NavBar } from "@/components/NavBar";
import { SwAutoReload } from "@/components/SwAutoReload";
import { VersionCheck } from "@/components/VersionCheck";

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
  other: {
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "default",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="apple-touch-icon" href="/icons/192.png" />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>
          <SwAutoReload />
          <VersionCheck />
          <NavBar />
          <main className="flex-1">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
