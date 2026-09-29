/** Bring an existing explanation into view instead of adding another copy after a blocked click. */
export function focusNotice(message: string, ...ids: (string | undefined)[]): boolean {
  for (const id of ids) {
    const notice = id ? document.getElementById(id) : null;
    if (!notice || notice.textContent !== message) continue;
    notice.focus({ preventScroll: true });
    notice.scrollIntoView({ block: 'nearest' });
    return true;
  }
  return false;
}
