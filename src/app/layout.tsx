import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "EcoLens — MEMSouth Environmental Monitor",
  description:
    "Real-time air quality, pollutants, and weather for any US zip code. " +
    "AQI, PM2.5, PM10, ozone, NO₂, CO, SO₂, wind, and more.",
  keywords: ["air quality", "AQI", "PM2.5", "Memphis", "environmental", "pollution"],
  openGraph: {
    title: "EcoLens Environmental Monitor",
    description: "Real-time AQI, pollutants, and weather for any US zip code.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
