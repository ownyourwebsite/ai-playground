import type { Metadata } from "next";
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

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export const metadata: Metadata = {
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
  },
  twitter: {
    card: "summary_large_image",
    title: "AI API Playground | Local-First MCP Developer Console",
    description: "The developer-first LLM playground with Model Context Protocol integration. Local-first, BYOK, open-source.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased min-h-screen font-sans bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
