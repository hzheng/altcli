# ADR-0002: Use a TypeScript web workspace

**Date:** September 14, 2026  
**Status:** Selected for the requested project scaffold  
**Amends:** ADR-0001's open stack decisions, not its external-controller boundaries

## Context

The user named the project AltCLI, confirmed TypeScript for both the web frontend
and Node backend, requested a Next.js App Router skeleton with Tailwind,
better-sqlite3 with raw SQL, Vitest, and Playwright, and reserved native iOS
implementation for later. The repository has separate `web/` and `ios/` areas.

## Decision

Use one `web/` package with React/Next.js App Router and TypeScript on both sides.
The Next application supplies the browser UI and versioned route handlers. All
terminal and persistence endpoints run in the Node.js runtime, never Edge.
No separate Express service, Nest application, or Vite server is introduced.

Keep the backend under `web/src/server/`, with a narrow terminal adapter.
Framework-independent validation and policy live in `web/src/core/`.
JSON-only types live in `web/src/contracts/`; `shared/openapi.yaml` describes the
wire contract for future clients. Routes adapt HTTP to the controller and must
not contain tmux command construction or Git workflow policy.

Use SQLite via better-sqlite3/raw SQL for registrations, command records, and the
manual-turn reservation. Keep its database outside AltCLI and every managed
worktree. The default base is `~/.local/share/altcli`, with separate `mock/`
and `tmux/` subdirectories. Raw pane snapshots are bounded and not persisted.

Use simple polling for the initial screen snapshots. The UI replaces a snapshot
rather than interpreting it as a new transcript entry. Snapshot availability is
not an agent lifecycle state, approval, or completion event.

Provide a mock adapter to develop and preview the UI without a tmux installation
or model account. Real input is separately opt-in even after selecting tmux mode.

Use a root forwarding `package.json`, one actual npm dependency workspace under
`web/`, and no additional monorepo manager. Use Node 24 as the suggested development
runtime. No unverified lockfile is included.

Reserve `ios/` with documentation, not an Xcode project. The prospective native
app is a client of the host controller. No standalone iOS storage, account system,
domain-core bridge, or cross-language code generation is adopted.

## Why this choice

It follows the user's existing project conventions and avoids choosing an unrelated
frontend/backend stack. One Node-hosted application is sufficient for a snapshot
console and low-volume personal coordination. Keeping backend logic independent
of route handlers permits a separate long-lived worker later if real scheduling
or a persistent terminal stream makes that useful.

These are design judgments for AltCLI.

## Explicit non-decisions

No third AI model, agent SDK, structured relay event protocol, permanent scheduler,
SSE/WebSocket stream, full browser terminal, native UI framework, notification
service, public hosting, or multi-user account system is selected here.

## Deployment boundary and tradeoffs

Run on the same macOS or Linux host and Unix user as tmux. Do not deploy this
application to a serverless platform expecting access to desktop tmux sessions.
A Docker example is intentionally omitted: in particular, a macOS Docker VM does
not automatically share the host's tmux socket, filesystem, process identity, or
user permissions. Containerization needs a separate deployment decision.

A native SQLite dependency needs a compatible prebuilt binary or local compiler.
Dependency installation and native-module compatibility must be verified locally.
The Next.js build, Vitest SQLite tests, and Playwright tests were not run in the
packaging environment because npm could not be reached.

The initial bearer-token flow is deliberately small and does not pretend to be a
finished phone pairing/login product. A hardened phone experience is a later
milestone. Use one backend instance per store; no replicas or clustered execution.

## Consequences and revisit triggers

Stack familiarity and a small deployment surface come at the cost of coupling the
first HTTP host to Next.js and using a native database module. Revisit the host
boundary when a persistent tmux control stream or scheduler requires a separate
process. Revisit authentication before wider deployment. Do not extract a generic
agent framework merely to justify the name.

## References

See [SOURCES.md](../SOURCES.md) for the official technical documentation.
