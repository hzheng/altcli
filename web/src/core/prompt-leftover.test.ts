import { expect, test } from "vitest";
import { inputAfterTyping } from "./prompt-leftover";

const command = 'Use the commit-handoff skill at "/repo/skills/commit-handoff/SKILL.md". Carry it out. [altcli-command:21bc7aa7-766d-4c25-9e96-71e8381bb238]';
const earlier = command.replace("21bc7aa7", "0d41656a");
const rule = "─".repeat(60);
// Layouts as captured from Claude Code 2.1.283 (rules around a ❯ row; the symbol is followed by a no-break space) and Codex
// (a › row, its composer ending at one blank row above a two-row footer at the bottom of the pane).
const claude = (...input: string[]) => `⏺ Earlier answer.\n❯ ${earlier}\n  Done.\n\n${rule}\n${input.join("\n")}\n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n\n`;
const codex = (...input: string[]) => `› ${earlier}\n\n  Worked for 6m\n\n${input.join("\n")}\n\n  GPT xhigh · ~/repo · Task\n  ? for shortcuts\n`;
const wrap = (text: string, first: string) => [`${first}${text.slice(0, 50)}`, `  ${text.slice(50, 100)}`, `  ${text.slice(100)}`];

test("only the command in the input area, plain or wrapped, is evidence that submitting sends just it", () => {
  expect(inputAfterTyping(claude(`❯ ${command}`), command)).toBe("only");
  expect(inputAfterTyping(claude(...wrap(command, "❯ ")), command)).toBe("only");
  expect(inputAfterTyping(codex(...wrap(command, "› ")), command)).toBe("only");
});
test("blank rows inside the input area belong to the draft in either layout", () => {
  // A multi-line command with an empty line is only itself.
  expect(inputAfterTyping(claude("❯ first", "", "  second"), "first\n\nsecond")).toBe("only");
  expect(inputAfterTyping(codex("› first", "", "  second"), "first\n\nsecond")).toBe("only");
  // The command typed in front of a draft that starts with two empty lines.
  expect(inputAfterTyping(claude(`❯ ${command}`, "", "", "  old instructions"), command)).toBe("mixed");
  expect(inputAfterTyping(codex(`› ${command}`, "", "", "  old instructions"), command)).toBe("mixed");
});
test("other text before the command, after the cursor, or containing a prompt-like character is mixed", () => {
  expect(inputAfterTyping(claude(`❯ i mean${command}`), command)).toBe("mixed");
  expect(inputAfterTyping(codex(...wrap(`${command}i mean`, "› ")), command)).toBe("mixed");
  expect(inputAfterTyping(claude(`❯ compare a >${command}`), command)).toBe("mixed");
  expect(inputAfterTyping(codex("› first line", `  second${command}`), command)).toBe("mixed");
  expect(inputAfterTyping(claude(`❯    ${command}`), command)).toBe("mixed");
});
test("draft text that looks like a rule, a box edge or a border is content, never a layout boundary", () => {
  for (const [layout, lead] of [[claude, "❯ "], [codex, "› "]] as const) {
    expect(inputAfterTyping(layout(`${lead}${command}`, "", "  ───", "  old instructions"), command)).toBe("mixed");
    expect(inputAfterTyping(layout(`${lead}${command}`, "", "  ╰ copied box", "  old instructions"), command)).toBe("mixed");
    expect(inputAfterTyping(layout(`${lead}${command}│`), command)).toBe("mixed");
    expect(inputAfterTyping(layout(`${lead}${command}─`), command)).toBe("mixed");
    // Empty lines left after the cursor are part of the draft too.
    expect(inputAfterTyping(layout(`${lead}${command}`, "", ""), command)).toBe("mixed");
  }
});
test("a paste token stands in only for a multi-line command, and only on its own", () => {
  expect(inputAfterTyping(claude("❯ [Pasted text #1 +2 lines]"), "line one\nline two")).toBe("only");
  expect(inputAfterTyping(claude("❯ draft[Pasted text #1 +2 lines]"), "line one\nline two")).toBe("unreadable");
  expect(inputAfterTyping(claude("❯ [Pasted text #1 +2 lines]"), command)).toBe("unreadable");
});
test("an input area whose end cannot be told apart from draft text is never taken as an empty draft", () => {
  expect(inputAfterTyping(`${rule}\n❯ ${command}\n\n  old instructions\n`, command)).toBe("unreadable"); // no closing rule
  expect(inputAfterTyping(`${rule}\n❯ ${command}\n${rule.slice(3)}\n`, command)).toBe("unreadable"); // not the same rule
  expect(inputAfterTyping(`╭────╮\n│ > ${command} │\n╰────╯\n`, command)).toBe("unreadable"); // an unsupported boxed layout
  expect(inputAfterTyping(`› ${command}\n  old instructions\n`, command)).toBe("unreadable"); // no blank row above a footer
  expect(inputAfterTyping(`› ${command}\n\n  one\n  two\n  three\n  four\n`, command)).toBe("unreadable"); // too tall for a footer
  expect(inputAfterTyping(`i mean${command}\n`, command)).toBe("unreadable");
  expect(inputAfterTyping("", command)).toBe("unreadable");
  expect(inputAfterTyping(codex("› Ask Codex to do anything"), command)).toBe("unreadable");
  expect(inputAfterTyping(codex(`› ${command.slice(0, 50)}`, `not indented ${command.slice(50)}`), command)).toBe("unreadable");
});
