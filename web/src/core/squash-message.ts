/** One sizing policy for the squash commit message, shared by the preview generator, request validation and the browser:
 * the message's JSON-encoded form (quotes and escapes included) is at most 8 KiB. The compact confirmation adds only bounded
 * identifiers and the consent digest, so every accepted message serializes well inside the 16 KiB request limit, and the
 * generated default obeys the same budget instead of having to be rewritten by hand. */
export const MAX_MESSAGE_JSON_BYTES = 8192;
export const messageJsonBytes = (message: string): number => new TextEncoder().encode(JSON.stringify(message)).length;
export const messageFits = (message: string): boolean => messageJsonBytes(message) <= MAX_MESSAGE_JSON_BYTES;
const MAX_SUBJECT = 120;
/** Subject line, provenance paragraph, then as many oldest-first commit subjects as fit the budget, closing with how many were left out. */
export function defaultSquashMessage(branch: string, mergeBase: string, head: string, commitCount: number, commitsNewestFirst: { subject: string }[]): string {
  const header = `Squash ${branch}\n\nSquash of ${branch} (${mergeBase.slice(0, 7)}..${head.slice(0, 7)}, ${commitCount} commit${commitCount === 1 ? '' : 's'}).\n\n`;
  const lines = [...commitsNewestFirst].reverse().map((c) => `- ${c.subject.length > MAX_SUBJECT ? `${c.subject.slice(0, MAX_SUBJECT - 1)}…` : c.subject}`);
  const render = (included: number) => {
    const omitted = commitCount - included;
    return `${header}${[...lines.slice(0, included), ...(omitted > 0 ? [`- … and ${omitted} more commit${omitted === 1 ? '' : 's'}`] : [])].join('\n')}\n`;
  };
  let included = 0;
  while (included < lines.length && messageFits(render(included + 1))) included++;
  const message = render(included);
  return messageFits(message) ? message : `Squash ${branch.slice(0, 200)}\n`; // only an absurd branch name reaches this
}
