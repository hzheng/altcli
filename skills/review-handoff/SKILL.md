---
name: review-handoff
description: Use when reviewing a change handed off by another AI or reviewer in an alternating review relay. Unless the user explicitly chooses HEAD or the index as baseline, use the index when unstaged or untracked work exists and HEAD otherwise. Review the current worktree against that baseline, advance accepted work to the index, then leave only this reviewer's improvements unstaged for the next reviewer. Also handle empty, accept-without-edit, and strong-objection outcomes.
---

# Review Handoff

## Goal

Keep each reviewer's contribution isolated in an alternating review relay.

At the start, honor any explicit instruction to use the current HEAD or index
as baseline. Otherwise select the baseline from repository state:

- If `git diff` is nonempty or `git status --short` lists any untracked path,
  use the index as the baseline. Treat the complete unstaged diff and the
  contents of in-scope untracked files as the incoming change.
- Otherwise, use HEAD as the baseline. Treat the complete `git diff HEAD` as
  the incoming tracked change; under automatic selection this normally equals
  `git diff --cached` because no unstaged paths exist.
- If neither source contains a change, there is no incoming handoff to review.

At the end, the index must contain the accepted incoming change, while
`git diff` must contain only this reviewer's improvements.

Explicitly requesting this handoff workflow authorizes staging only the
reviewed incoming change. Do not infer authorization to stage from an ordinary
code-review request.

## Workflow

1. Run `git status --short`, then inspect `git diff` and account for every
   untracked path before any edit or staging operation. Unless the user chose
   HEAD or the index explicitly, use the index as baseline when either source
   contains a change and HEAD only when both are empty. Inspect the complete
   baseline diff: `git diff` for the index or `git diff HEAD` for HEAD. Use the
   applicable `--stat` and `--check` forms as useful supplements, but review the
   complete patch and its surrounding code.
2. With the index as baseline, treat only the worktree diff and in-scope
   untracked files as the incoming change list; consult the staged diff only for
   context. With HEAD as baseline, treat the complete worktree relative to HEAD
   as incoming, including staged, unstaged, and in-scope untracked content. If a
   path contains any unstaged hunk outside the handoff, either review the entire
   path as incoming or stop; a path-level `git add` cannot preserve conceptual
   ownership between hunks.
3. Read untracked files completely because `git diff` omits them. Include them
   only when they clearly belong to the handoff; never sweep unrelated files
   into the index. The presence of any untracked path still selects the index as
   the default baseline, even when that path is later excluded from the scope.
4. Review for correctness, regressions, risky behavior, and missing tests. Run
   focused tests or checks when practical.
5. Choose exactly one outcome:

   - **No incoming handoff:** Report that there is nothing to review and stop.
     Do not stage or edit anything. This also applies when untracked paths
     selected the index as baseline but all were excluded from the scope and no
     tracked unstaged change remains.
   - **Strong objection:** Leave the index and worktree untouched. Report the
     blocking findings and stop. Do not stage or layer edits onto a rejected
     incoming change.
   - **Accept without improvement:** Stage the complete reviewed incoming
     worktree content, including any reviewed untracked files. Content already
     synchronized to the index needs no staging; then stop.
   - **Accept and improve:** Stage the complete reviewed incoming change first,
     except content already synchronized to the index. Verify that none of that
     accepted change remains in `git diff`, then apply the improvement.

6. Immediately before staging, rerun `git status --short` and the complete diff
   that supplied the incoming change: `git diff -- <reviewed-paths>` for an
   index-baseline handoff or `git diff HEAD -- <reviewed-paths>` for a
   HEAD-baseline handoff. Reread every reviewed untracked file completely. If
   the content or automatic baseline selection differs from what was reviewed,
   review the new incoming state before proceeding. Stage exact reviewed paths
   that contain accepted unstaged or untracked content; content already in the
   index needs no staging. Do not use a broad add when unrelated worktree files
   exist.
7. Before editing an improvement target, verify that it has no pre-existing
   unstaged or untracked work. If it does, stage it only when it was part of the
   accepted incoming change; otherwise do not mix a new edit into that path.
8. After making an improvement, run relevant checks and inspect `git diff`
   again. It must show only this reviewer's outgoing change. Do not stage that
   outgoing change; the next reviewer will review and stage it.

## Handoff Invariants

- An explicit user choice of the current HEAD or index as baseline overrides
  automatic selection.
- Never edit before staging an accepted incoming change.
- Never stage the current reviewer's own improvement.
- Never stage a path whose complete current worktree delta was not reviewed.
- Start outgoing edits only from paths that are clean against the accepted
  index, or from genuinely new paths that were absent at handoff start.
- Do not alter or discard pre-existing staged content except by advancing the
  reviewed paths to their accepted worktree versions.
- A tracked file commonly returns to `MM` after an accepted incoming edit is
  staged and a new outgoing edit is made. Other valid statuses, such as `AM`
  for a newly added file, may express the same index/worktree separation.
- A status with only an index column (for example `M ` or `A `) is an
  already-synchronized incoming handoff only when there are no tracked
  unstaged changes and no untracked paths. In that case, review
  `git diff --cached` against HEAD; do not mistake the empty `git diff` for an
  empty incoming change.
- If no improvement is warranted, a clean `git diff` is the correct result:
  the accepted change is staged and there is nothing to hand off.

## Output

Lead with severity-ranked findings. Then state the handoff outcome, the paths
staged, any improvement left unstaged, and the checks actually run. If refusing
the change, explicitly state that nothing was staged or edited.

End the message with exactly one final line, and nothing after it:

    RELAY-OUTCOME: <outcome> — <one sentence>

where `<outcome>` is one of `no_incoming_handoff`, `strong_objection`,
`accept_without_improvement`, or `accept_and_improve`, and the sentence names the
blocking finding for an objection, or the improvement left unstaged otherwise. A
`strong_objection` sentence must be a standalone, actionable explanation suitable
for sending directly to the author; never omit it.
A controller may read this line from the final message; keep it literal and last.
