import { expect, test } from "vitest";
import { singleLine, parseCommand } from "./validation";
test("single-line validation accepts Unicode and punctuation", () => { expect(singleLine("Review 中文; do not edit.")).toBe("Review 中文; do not edit."); });
test("single-line validation rejects embedded terminal controls", () => { expect(() => singleLine("relay\nrm -rf data")).toThrow(); });
test("explicit readiness and UUID are required", () => { expect(() => parseCommand({ kind: "relay", agentId: "codex" })).toThrow(); });
