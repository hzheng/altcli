import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "@xterm/xterm/css/xterm.css";
export const metadata: Metadata = { title: "AltCLI | Agent Console", description: "Agents alternating on the CLI: a self-hosted control center for AI coding agents.", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#101719" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
