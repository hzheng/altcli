// Read-only preview of the ADR-0024 store upgrade: what still blocks it and what migration would record. Changes nothing.
// Usage: npm run upgrade:check [-- <data directory>]; the default is the host's configured data directory.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectUpgrade, REGISTRY_SCHEMA } from '../src/server/upgrade.ts';
const directory = process.argv[2] ?? resolve(process.env.ALTCLI_DATA_DIR ?? join(homedir(), '.local', 'share', 'altcli'), process.env.ALTCLI_ADAPTER ?? 'tmux');
const path = join(directory, 'altcli.sqlite3');
if (!existsSync(path)) { console.log(`No store at ${path}. A new store starts at schema ${REGISTRY_SCHEMA}.`); process.exit(0); }
const report = inspectUpgrade(path);
if (report.version >= REGISTRY_SCHEMA) { console.log(`${path} is already at schema ${report.version}.`); process.exit(0); }
console.log(`${path}: schema ${report.version}; this version upgrades it to ${report.target} only when nothing below is unresolved.`);
for (const b of report.blockers) console.log(`  unresolved ${b.kind} ${b.id}: ${b.detail}`);
console.log(report.blockers.length ? 'Settle these with the previous AltCLI version, stop it, then start this version.' : 'Nothing is unresolved; the upgrade can proceed.');
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
console.log(`Migration would record ${count(report.repositories, 'repository registration')} awaiting your confirmation; task workspaces: ${report.workspaces.active} active, `
  + `${report.workspaces.pending} pending (no saved record proves their identity), ${report.workspaces.retired} retired; ${count(report.linkedLaunches, 'launched agent')} linked to them.`);
process.exit(report.blockers.length ? 1 : 0);
