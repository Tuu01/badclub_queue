import type { Metadata, Viewport } from "next";
import "./globals.css";
import { CodeModal } from "./code-modal";

export const metadata: Metadata = {
  title: "Badminton Queue",
  description: "Session manager for the badminton club",
};

export const viewport: Viewport = {
  themeColor: "#061A18",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400;100..125,500&family=Instrument+Sans:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        <CodeModal />
      </body>
    </html>
  );
}
