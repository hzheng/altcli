import type { NextConfig } from "next";
const config: NextConfig = {
  // Next locks the dist dir per dev server; the e2e suite runs one server per viewport from this workspace.
  ...(process.env.ALTCLI_DIST_DIR ? { distDir: process.env.ALTCLI_DIST_DIR } : {}),
  poweredByHeader: false,
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
};
export default config;
