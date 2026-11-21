import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import clsx from "clsx";
import "./globals.css";

const jetBrainsMono = JetBrains_Mono({
  weight: "400",
  subsets: [],
  preload: true,
});

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:3000"),
  title: "TTS",
  description: "An interactive demo for developers to try the new text-to-speech model in the OpenAI API",
  authors: [{ name: "OpenAI" }],
  openGraph: {
    title: "TTS",
    description: "An interactive demo for developers to try the new text-to-speech model in the OpenAI API",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "TTS, a text-to-speech app",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={clsx("antialiased", jetBrainsMono.className)}>
        {children}
      </body>
    </html>
  );
}
