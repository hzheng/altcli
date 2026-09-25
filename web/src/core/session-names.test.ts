import { expect, test } from "vitest";
import { SESSION_NAME_LIMIT, sessionNamesOf, uniqueSessionName } from "./session-names";
test("a free base is used as is; collisions take the first free numbered suffix, filling gaps", () => {
  expect(uniqueSessionName("CX-feature-ui1", new Set())).toBe("CX-feature-ui1");
  expect(uniqueSessionName("CX-feature-ui1", new Set(["CX-feature-ui1"]))).toBe("CX-feature-ui1-2");
  expect(uniqueSessionName("CX-feature-ui1", new Set(["CX-feature-ui1", "CX-feature-ui1-2", "CX-feature-ui1-4"]))).toBe("CX-feature-ui1-3");
  // A longer name that merely starts with the base does not occupy it.
  expect(uniqueSessionName("CX-main", new Set(["CX-main-feature", "CX-mainline"]))).toBe("CX-main");
});
test("the bound is explicit instead of silently growing", () => {
  const taken = new Set(["a", ...Array.from({ length: SESSION_NAME_LIMIT - 1 }, (_, i) => `a-${i + 2}`)]);
  expect(() => uniqueSessionName("a", taken)).toThrow(/already use the name a/);
});
test("session names come from pane locations, including names that contain dashes", () => {
  expect([...sessionNamesOf([{ location: "CX-main:0.0" }, { location: "CX-main:1.2" }, { location: "demo:0.1" }])]).toEqual(["CX-main", "demo"]);
});
