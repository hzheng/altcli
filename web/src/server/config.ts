import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { AdapterMode, HostConfig } from "../contracts/api.ts";
import { AppError } from "../core/errors.ts";
export interface Config {
  mode: AdapterMode;
  token: string;
  allowedOrigins: string[];
  inputEnabled: boolean;
  terminalEnabled?: boolean;
  launchEnabled?: boolean;
  dataDir: string;
  tmuxBin: string;
  tmuxSocket?: string;
  legacyEnabled?: boolean;
  /** Branch names that are creation bases, never implementation branches; the detected default branch is always added. */
  integrationBranches: string[];
  /** Host-local task checkouts, separate from controller metadata. Tests use an isolated root. */
  worktreeDir?: string;
  /** The CLIs' user-level configuration, read only to see where the installed AltCLI hooks and skill links point. */
  claudeConfigDir: string;
  codexHome: string;
}
// Not NodeJS.ProcessEnv: Next's global types make NODE_ENV required there, which breaks the partial env objects tests pass.
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // tmux is the product; the mock adapter exists for automated tests and UI work without a tmux server.
  const mode = env.ALTCLI_ADAPTER ?? "tmux";
  if (mode !== "mock" && mode !== "tmux") throw new AppError("CONFIG", "ALTCLI_ADAPTER must be mock or tmux.", 503);
  const token = env.ALTCLI_TOKEN ?? "";
  if (!/^[0-9a-f]{64}$/i.test(token)) throw new AppError("CONFIG", "Run node scripts/setup.mjs to create a random access token.", 503);
  // Every send still needs a registered pane, a fresh identity check, and the per-command readiness confirmation;
  // this switch only turns the console read-only.
  const input = env.ALTCLI_ENABLE_INPUT ?? "true";
  if (!["true", "false"].includes(input)) throw new AppError("CONFIG", "ALTCLI_ENABLE_INPUT must be true or false.", 503);
  const terminal = env.ALTCLI_ENABLE_TERMINAL ?? 'false';
  const launch = env.ALTCLI_ENABLE_AGENT_LAUNCH ?? 'false';
  if (![terminal, launch].every(v => ['true','false'].includes(v))) throw new AppError('CONFIG', 'Terminal and launch flags must be true or false.', 503);
  const base = env.ALTCLI_DATA_DIR ?? join(homedir(), ".local", "share", "altcli");
  if (!isAbsolute(base)) throw new AppError("CONFIG", "ALTCLI_DATA_DIR must be absolute.", 503);
  const allowedOrigins = (env.ALTCLI_ALLOWED_ORIGINS ?? "http://127.0.0.1:8787,http://localhost:8787").split(",").map((s) => s.trim());
  for (const origin of allowedOrigins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new AppError("CONFIG", "Invalid allowed origin.", 503); }
    if (url.origin !== origin || !["https:", "http:"].includes(url.protocol)) throw new AppError("CONFIG", "Allowed origins must be exact HTTP(S) origins without paths or wildcards.", 503);
    if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new AppError("CONFIG", "Non-loopback origins must use HTTPS.", 503);
  }
  const legacy = env.ALTCLI_ENABLE_LEGACY_RELAY ?? 'false';
  if (!['true', 'false'].includes(legacy)) throw new AppError('CONFIG', 'ALTCLI_ENABLE_LEGACY_RELAY must be true or false.', 503);
  const integrationBranches = (env.ALTCLI_INTEGRATION_BRANCHES ?? 'main,master').split(',').map((s) => s.trim()).filter(Boolean);
  if (integrationBranches.some((name) => !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,150}$/.test(name))) throw new AppError('CONFIG', 'ALTCLI_INTEGRATION_BRANCHES must be a comma-separated list of branch names.', 503);
  return { mode, token, allowedOrigins, terminalEnabled: terminal === 'true', launchEnabled: launch === 'true', inputEnabled: input === "true", legacyEnabled: legacy === 'true', integrationBranches,
    worktreeDir: join(homedir(), '.altcli'),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), codexHome: env.CODEX_HOME ?? join(homedir(), '.codex'),
    dataDir: resolve(base, mode), tmuxBin: env.ALTCLI_TMUX_BIN ?? "tmux",
    ...(env.ALTCLI_TMUX_SOCKET ? { tmuxSocket: env.ALTCLI_TMUX_SOCKET } : {}) };
}
const SETTINGS = ["ALTCLI_ENABLE_TERMINAL", "ALTCLI_ENABLE_AGENT_LAUNCH", "ALTCLI_ADAPTER", "ALTCLI_ENABLE_INPUT", "ALTCLI_ENABLE_LEGACY_RELAY", "ALTCLI_DATA_DIR", "ALTCLI_TMUX_BIN", "ALTCLI_TMUX_SOCKET",
  "ALTCLI_INTEGRATION_BRANCHES", "ALTCLI_ALLOWED_ORIGINS", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
/** Where an executable name resolves through PATH, or the configured absolute path when it is executable; null otherwise. */
export function resolveExecutable(binary: string, env: Record<string, string | undefined> = process.env): string | null {
  const candidates = isAbsolute(binary) || binary.includes("/") ? [resolve(binary)] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, binary));
  for (const candidate of candidates) { try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ } }
  return null;
}
/** The effective configuration for display. The token never leaves the server. */
export function describeConfig(config: Config, env: Record<string, string | undefined> = process.env): HostConfig {
  return { mode: config.mode, terminalEnabled: config.terminalEnabled === true, launchEnabled: config.launchEnabled === true, inputEnabled: config.inputEnabled, legacyEnabled: config.legacyEnabled === true, dataDir: config.dataDir, worktreeDir: config.worktreeDir ?? join(homedir(), ".altcli"),
    tmuxBin: config.tmuxBin, tmuxPath: resolveExecutable(config.tmuxBin, env), tmuxSocket: config.tmuxSocket ?? null, integrationBranches: config.integrationBranches,
    allowedOrigins: config.allowedOrigins, claudeConfigDir: config.claudeConfigDir, codexHome: config.codexHome, environment: SETTINGS.filter((name) => env[name] !== undefined) };
}
