import { expect, test } from "vitest";
import { defaultSquashMessage, MAX_MESSAGE_JSON_BYTES, messageFits, messageJsonBytes } from "./squash-message";
const commits = (n: number, subject = (i: number) => `commit ${i}`) => Array.from({ length: n }, (_, i) => ({ subject: subject(n - 1 - i) })); // newest first
test("a short history lists every subject oldest first and fits", () => {
  const message = defaultSquashMessage("feature/x", "b".repeat(40), "a".repeat(40), 2, commits(2));
  expect(message).toBe("Squash feature/x\n\nSquash of feature/x (bbbbbbb..aaaaaaa, 2 commits).\n\n- commit 0\n- commit 1\n");
  expect(messageFits(message)).toBe(true);
});
test("a long history is cut at the budget and says how many commits were left out, counting unlisted ones", () => {
  const message = defaultSquashMessage("feature/x", "b".repeat(40), "a".repeat(40), 140, commits(100, () => "y".repeat(119)));
  expect(messageJsonBytes(message)).toBeLessThanOrEqual(MAX_MESSAGE_JSON_BYTES);
  const listed = message.split("\n").filter((line) => line.startsWith("- y")).length;
  expect(listed).toBeGreaterThan(50); expect(listed).toBeLessThan(100);
  expect(message).toMatch(new RegExp(`- … and ${140 - listed} more commits\\n$`));
  expect(messageFits(defaultSquashMessage("feature/x", "b".repeat(40), "a".repeat(40), 140, commits(100, () => "y".repeat(119)).map((c) => ({ subject: `${c.subject}\"` }))))).toBe(true); // escapes count
});
test("over-long subjects are shortened and the budget counts JSON escaping", () => {
  const message = defaultSquashMessage("feature/x", "b".repeat(40), "a".repeat(40), 1, [{ subject: "s".repeat(500) }]);
  expect(message).toContain(`- ${"s".repeat(119)}…\n`);
  expect(messageJsonBytes('"'.repeat(4095))).toBe(MAX_MESSAGE_JSON_BYTES); expect(messageFits('"'.repeat(4096))).toBe(false);
  expect(messageFits("x".repeat(8190))).toBe(true); expect(messageFits("x".repeat(8191))).toBe(false);
});
