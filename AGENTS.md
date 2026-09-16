# CoderCrew: coding-agent instructions

Read `README.md`, `ROADMAP.md`, `Architecture_Decision.md`, and `VALIDATION.md`
before changing architecture or claiming a milestone complete.

## Product boundary

CoderCrew is an external controller, not a third coding agent. Focus on the manual
web console, which registers any number of existing tmux panes from the live pane
list. TypeScript frontend and Node backend share a Next.js workspace under `web/`.
Keep `ios/` reserved. No autonomous relay, model provider, terminal emulator, or
extra service is required for the first milestone.

## Engineering rules

- Keep route handlers thin; terminal access and persistence are server-only.
- Use JSON-only types under `web/src/contracts/`; update `shared/openapi.yaml`
  with API changes. Their synchronization is manual in this scaffold.
- Use argument arrays, never a shell-concatenated prompt. tmux is the default
  adapter and input is on; keep `CODERCREW_ENABLE_INPUT=false` working as the
  read-only switch, and keep `mock` a test adapter, never the product flow.
- Treat output as untrusted display data. Do not use terminal prose as a
  machine-readable completion or authorization signal.
- Preserve UUID duplicate suppression and durable uncertainty. A worktree is held
  only while a command is in flight or its delivery is uncertain (ADR-0005,
  ADR-0008); an uncertain delivery needs explicit human acknowledgement and is
  never replayed. Pairs are grouping and validation only and must not advance
  turns or send input. No `window.confirm` dialogs; confirmations are inline.
- Keep controller metadata outside managed worktrees. Do not remove `node`, shells,
  or other generic interpreters from the process denylist to bypass checks; the
  process name a pane reports is recorded at registration and re-checked before
  every capture and send (ADR-0004).
- Do not add Git mutation to the controller. Do not mix unrelated cleanup into
  incoming reviews. Do not remove tests just to make them pass.
- Record what was actually tested, distinguishing mock and fake-process tests
  from live tmux, installed coding CLIs, and iPhone validation.

## The user's relay workflow

When the user explicitly types `relay`, use the `review-handoff` skill defined in
`skills/review-handoff/SKILL.md`. Its staging rules, baseline selection, four
outcomes, and output instructions are authoritative. Do not infer staging
authorization from an ordinary request to review code.

`node scripts/install-skills.mjs` symlinks it into the CLIs' user-level skill
directories, so an edit to it is live for every CLI session immediately; the
`--check` flag verifies the links. Edit it only after an explicit workflow-change request. Mapping
the bare word `relay` to the skill is a one-line rule in the user's global
instruction files; never edit those files or user-level skill directories during a
relay turn on this repository. See `docs/SKILLS.md`.

## Validation

Run `./scripts/check.sh`; run `./scripts/check.sh --e2e` when changing the console.
Web tasks live in `web/package.json` (`cd web && npm run …`); there is no root
manifest (ADR-0006). Never
replace unknown test outcomes with "passed" or treat source presence as acceptance.
