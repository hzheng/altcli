import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { AppError } from "../core/errors.ts";
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export function assertExternalDataDir(dataDir: string, repository: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (isWithin(realpathSync(repository), realpathSync(dataDir))) throw new AppError("UNSAFE_DATA_DIR", "Controller data must be outside the managed worktree.", 409);
}
