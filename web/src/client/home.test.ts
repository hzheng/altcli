import { expect, test } from "vitest";
import { tildify } from "./home";

test("the home directory is shown as ~ where it begins a path, in paths and in prose", () => {
  expect(tildify("/Users/me/.altcli/repo/main", "/Users/me")).toBe("~/.altcli/repo/main");
  expect(tildify("/Users/me", "/Users/me/")).toBe("~");
  expect(tildify("Exported 2 runs for /Users/me/repo. Removed /Users/me/a, /Users/me/b", "/Users/me")).toBe("Exported 2 runs for ~/repo. Removed ~/a, ~/b");
  expect(tildify("Main checkout · /Users/me/repo (clean)", "/Users/me")).toBe("Main checkout · ~/repo (clean)");
});
test("other paths and names that only start like it are unchanged", () => {
  expect(tildify("/Users/me2/repo", "/Users/me")).toBe("/Users/me2/repo");
  expect(tildify("/Users/me.bak/repo", "/Users/me")).toBe("/Users/me.bak/repo");
  expect(tildify("/private/Users/me/repo", "/Users/me")).toBe("/private/Users/me/repo");
  expect(tildify("/home/fixture/repo", "")).toBe("/home/fixture/repo");
  expect(tildify("/tmp/a+b/(x)", "/tmp/a+b")).toBe("~/(x)");
});
