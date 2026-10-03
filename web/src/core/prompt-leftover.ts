/** Only whitespace is ignored when comparing: CLIs wrap long input at arbitrary points and indent continuation rows. Every other
 * character, including ones that look like borders, is draft content. */
const squeeze = (value: string) => value.replace(/\s/gu, '');
/** The input row: a prompt symbol in column 0, then any space, including Claude Code's no-break space. Draft rows are indented. */
const PROMPT_ROW = /^[>›❯](?:\s|$)/u;
/** Claude Code rules its input area off with identical full rules in column 0 above and below. */
const RULE = /^─{3,}$/u;
/** Codex draws its composer, one blank row, then a footer of at most this many rows at the bottom of the pane. */
const FOOTER_ROWS = 3;

/** The rows of the input area that starts at `start`, or null when its end cannot be told apart from draft text. Claude Code's area
 * ends at the row identical to the rule above it; Codex's at the last blank row above its footer. Layout cells are only recognized in
 * column 0, where draft text never is, and blank rows inside the area are part of the draft. */
function inputArea(rows: string[], start: number): string[] | null {
  const above = rows[start - 1] ?? '';
  if (RULE.test(above)) {
    const end = rows.indexOf(above, start + 1);
    return end < 0 ? null : rows.slice(start, end);
  }
  let last = rows.length - 1;
  while (last > start && !rows[last]) last--;
  let blank = last;
  while (blank > start && rows[blank]) blank--;
  if (blank <= start || last - blank > FOOTER_ROWS) return null;
  return rows.slice(start, blank);
}

function inputRows(screen: string): string[] | null {
  const rows = screen.split('\n').map((row) => row.replace(/\s+$/u, ''));
  let start = rows.length - 1;
  while (start >= 0 && !PROMPT_ROW.test(rows[start]!)) start--;
  const area = start < 0 ? null : inputArea(rows, start);
  return !area || area.slice(1).some((row) => row && !row.startsWith('  ')) ? null : area;
}
/** Upper bound on visible draft characters, including wrapping/indentation. Used only after the typed command is verified in a
 * mixed draft. Backspace and Delete remove text on both sides of the cursor without submitting or sending an interrupt. */
export function inputEraseCount(screen: string): number | null {
  const area = inputRows(screen);
  return area ? Array.from(area.join('\n')).length : null;
}
/** What the agent's input area holds after the controller typed `typed` into it, read from a capture of the visible pane before
 * submitting. `only`: exactly the command, nothing before it, after the cursor or on other rows, and no blank rows the command does
 * not have (a multi-line paste may show as one paste token). `mixed`: the command is visible together with other text. `unreadable`:
 * no input area in Claude Code's or Codex's layout, an end that cannot be told apart from draft text, or the command not visible as
 * typed. Only `only` is evidence that submitting sends just this command. The input area is the last row starting with a prompt
 * symbol, below any earlier prompts in the scrollback. */
export function inputAfterTyping(screen: string, typed: string): 'only' | 'mixed' | 'unreadable' {
  const area = inputRows(screen);
  const mine = squeeze(typed);
  if (!area || !mine) return 'unreadable';
  const first = area[0]!.replace(PROMPT_ROW, ''), shown = squeeze([first, ...area.slice(1)].join(''));
  if (typed.includes('\n') && /^\[Pasted[^\]]*\]$/u.test(shown)) return 'only';
  // Whitespace-insensitive equality would accept a draft of spaces or empty lines: the command must start right after the prompt
  // symbol, and the area may hold only as many blank rows as the command has empty lines.
  const blankRows = area.filter((row) => !row).length, emptyLines = typed.split('\n').filter((line) => !line.trim()).length;
  if (shown === mine && first.startsWith(Array.from(typed.trimStart())[0]!) && blankRows === emptyLines) return 'only';
  return shown.includes(mine) ? 'mixed' : 'unreadable';
}
