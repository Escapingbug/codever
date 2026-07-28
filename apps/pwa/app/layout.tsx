import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Codever",
    template: "%s · Codever",
  },
  description: "Talk to your coding agents securely from every device.",
  applicationName: "Codever",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Codever",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: "website",
    title: "Codever — Secure Agent Workspace",
    description: "Talk to your coding agents securely from every device.",
    images: [{
      url: "/codever-social.png",
      width: 1728,
      height: 919,
      alt: "An encrypted Codever agent conversation between phone and desktop",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Codever — Secure Agent Workspace",
    description: "Talk to your coding agents securely from every device.",
    images: ["/codever-social.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#191b2c",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
