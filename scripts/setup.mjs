import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const source = new URL("../web/.env.example", import.meta.url);
const target = new URL("../web/.env.local", import.meta.url);
const token = randomBytes(32).toString("hex");
const template = (await readFile(source, "utf8")).replace("REPLACE_WITH_A_RANDOM_64_CHARACTER_HEX_TOKEN", token);
try {
  await writeFile(target, template, { flag: "wx", mode: 0o600 });
  console.log("Created web/.env.local for the local tmux server. Your access token (keep private):\n" + token);
  console.log("Next: npm --prefix web ci, then: cd web && npm run dev");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("web/.env.local already exists; nothing was overwritten. Read your token from that file.");
}
