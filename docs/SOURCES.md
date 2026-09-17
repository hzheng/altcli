# Reference sources and provenance

Inspected September 14, 2026. Source observations and CoderCrew design choices are
separated below. Repository access was read-only; no GitHub files were changed.

## User-provided sources

- The uploaded `SKILL.md`, kept unchanged at `skills/review-handoff/SKILL.md`
  and symlinked into the CLIs' skill directories by `node scripts/install-skills.mjs`.
  In particular: accepted incoming work is staged; the current reviewer's
  improvements remain unstaged; the four outcomes are preserved.
- The uploaded `ROADMAP.md` and `ADR-0001-tmux-web-controller.md`. Exact originals
  are archived under `docs/history/2026-09-13/`. Their original date is retained.
- The conversation's September 14 decisions: CoderCrew as project name,
  TypeScript frontend and backend, web-first development, native iOS reserved,
  and a ZIP starter delivery.

## Official technical references

- [Next route handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route): HTTP route handlers and Web Request/Response APIs.
- [Next runtime configuration](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config): Node runtime boundary.
- [tmux manual](https://man.openbsd.org/tmux.1): persistent sessions, exact pane IDs, metadata formats, capture-pane, send-keys, hex input, and command parsing.
- [Codex skills](https://developers.openai.com/codex/skills/): repository `.agents/skills` discovery.
- [Claude Code skills](https://code.claude.com/docs/en/skills): project `.claude/skills` discovery.
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve): private service exposure and Serve configuration.

Dependency versions are not asserted to be the latest available packages. The
packaging runtime could not resolve npm's registry;
no registry download, dependency audit, lockfile resolution, or full web build was
completed. Consult `VALIDATION.md` for the actual checks.
