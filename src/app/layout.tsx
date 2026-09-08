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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

const SITE_URL = "https://ai-playground.ownyourwebsite.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: {
    canonical: "/",
  },
  title: "AI API Playground | Local-First MCP Developer Console",
  description: "A developer-first, local-first LLM playground that integrates the Model Context Protocol (MCP) directly into your browser. Configure models, connect remote/hosted MCP servers, trace request/response payloads in raw JSON, and export production-ready snippets.",
  keywords: [
    "AI playground",
    "Own Your Playground",
    "AI API Playground",
    "Model Context Protocol",
    "MCP Server Client",
    "Local-First LLM Playground",
    "GitHub MCP",
    "Human-in-the-loop AI",
    "BYOK AI Client",
    "Developer Console",
    "Developer Diagnostics",
    "Vercel AI SDK Code Export"
  ],
  authors: [{ name: "Own Your Website" }],
  creator: "Own Your Playground",
  openGraph: {
    title: "AI API Playground | Local-First MCP Developer Console",
    description: "Connect remote/hosted MCP servers, trace payloads, configure custom models, and keep your keys local & secure. Zero backend costs.",
    type: "website",
    locale: "en_US",
    siteName: "AI API Playground",
    images: [
      {
        url: "/og/og-image.png",
        width: 1734,
        height: 907,
        alt: "AI API Playground | Local-First MCP Developer Console",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "AI API Playground | Local-First MCP Developer Console",
    description: "The developer-first LLM playground with Model Context Protocol integration. Local-first, BYOK, open-source.",
    images: [
      {
        url: "/og/og-image.png",
        width: 1734,
        height: 907,
        alt: "AI API Playground | Local-First MCP Developer Console",
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "AI API Playground",
    alternateName: "Own Your Playground",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    url: SITE_URL,
    description:
      "A developer-first, local-first LLM playground with Model Context Protocol (MCP) integration. BYOK, zero backend costs, open-source.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    license: "https://opensource.org/licenses/MIT",
    author: {
      "@type": "Organization",
      name: "Own Your Website",
      url: "https://ownyourwebsite.app",
    },
    codeRepository: "https://github.com/ownyourwebsite/ai-playground",
  };

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased min-h-screen font-sans bg-background text-foreground">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
