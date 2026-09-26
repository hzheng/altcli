import { expect, test } from "vitest";
import { lacksCodexNoDaemon } from "./policy";
test("a direct Codex executable needs --no-daemon regardless of its display hint", () => {
  expect(lacksCodexNoDaemon({ adapterHint: "codex", executable: "codex", args: [] })).toBe(true);
  expect(lacksCodexNoDaemon({ adapterHint: "manual", executable: "/opt/homebrew/bin/codex", args: ["--model", "x"] })).toBe(true);
  expect(lacksCodexNoDaemon({ adapterHint: "codex", executable: "codex", args: ["--no-daemon"] })).toBe(false);
  expect(lacksCodexNoDaemon({ adapterHint: "claude", executable: "claude", args: [] })).toBe(false);
  expect(lacksCodexNoDaemon({ adapterHint: "manual", executable: "/bin/zsh", args: [] })).toBe(false);
});
test.each([
  { executable: "/bin/zsh", args: ["-lc", "exec codex --no-daemon"] },
  { executable: "/bin/zsh", args: ["-lc", "exec codex"] },
  { executable: "/opt/bin/codex-wrapper", args: [] },
])("a Codex hint does not establish that $executable accepts Codex arguments", profile => {
  expect(lacksCodexNoDaemon({ ...profile, adapterHint: "codex" })).toBe(false);
});
