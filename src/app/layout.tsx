import type { Metadata } from "next";
import { headers } from "next/headers";
import { ClerkProvider } from "@clerk/nextjs";
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

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host?.includes("localhost") ? "http" : "https");
  const baseUrl = host
    ? new URL(`${protocol}://${host}`)
    : new URL(process.env.APP_BASE_URL ?? "http://localhost:3000");

  return {
    metadataBase: baseUrl,
    title: {
      default: "Searchlight · Job Command Center",
      template: "%s · Searchlight",
    },
    description:
      "A private command center for job discovery, review, applications, and follow-ups.",
    openGraph: {
      title: "Searchlight · Job Command Center",
      description: "Signal. Decide. Move forward.",
      type: "website",
      images: [
        {
          url: new URL("/og.png", baseUrl),
          width: 1200,
          height: 630,
          alt: "Searchlight job command center",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Searchlight · Job Command Center",
      description: "Signal. Decide. Move forward.",
      images: [new URL("/og.png", baseUrl)],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full">{children}</body>
      </html>
    </ClerkProvider>
  );
}
