# Security boundary and limits

CoderCrew is a privileged local application: it can submit instructions to coding
agents that may already have filesystem, shell, network, and credential access.
It is not a sandbox and does not reduce those agents' existing permissions.

## Starter defaults

The backend binds to `127.0.0.1:8787`. All API reads and writes require a randomly
generated 256-bit bearer token. The server validates an exact host/origin allowlist,
refuses cross-site browser requests, and does not enable permissive CORS.
Authentication does not depend on cookies; native clients may omit Origin but
must supply the same bearer token. The UI shell alone contains no live output.

`node scripts/setup.mjs` generates `web/.env.local` with restrictive permissions and never
overrides it. No real access token is shipped. Tokens must never use a
`NEXT_PUBLIC_*` variable, appear in a URL, or be committed. Rotate a token by replacing
it with a new random 64-character hex value and restarting the host. Browser tokens
live only in page memory. This is not a complete login/pairing/session product.

The default adapter is tmux and input is enabled: a send still needs a registered
pane, a fresh identity check, and the per-command readiness confirmation. The
host-side `CODERCREW_ENABLE_INPUT=false` switch makes the console read-only; it
cannot be changed by a browser request. The `mock` adapter simulates panes for the
automated tests and never touches a terminal.
There is no generic shell execution, arbitrary tmux command, skill-installation,
filesystem-browsing, or Git-mutation endpoint. The registration endpoints only
record or forget a pane the token holder chose from the live listing; they never
send input, and they are refused while the worktree has a command in flight or an
unacknowledged uncertain delivery.

The console state includes every pane on the configured tmux server, with its
current directory and process name, so the token holder can pick one, and the
preview endpoint returns the last lines of any pane on request. Treat the token as
full read access to every pane's screen and metadata on that tmux server, even for
panes that are never registered. Pair endpoints only record which two registered
sessions share a worktree; they send nothing.

`POST /api/v1/events` accepts turn-complete events from the CLIs' own hooks on
this host, behind the same token. An event is matched to a pane by exact tmux
identity and is informational only: it never sends input, clears a hold, or
advances a turn; it pre-ticks the readiness box, which the human can untick. The
hook script reads the token from `web/.env.local` and posts to loopback only.

Commands use size-limited JSON, UUID v4 identities, explicit agent IDs and human
readiness confirmation. Terminal bytes are passed as hex arguments to `send-keys`
without shell interpolation. Screen text is rendered as React text, never injected
HTML or trusted instructions to the controller. Do not add `dangerouslySetInnerHTML`
to render agent output. No full ANSI emulator is supplied.

## Important residual risks

Process names and tmux metadata are transport checks, not attestation. The name
recorded at registration is whatever the pane reported then; the denylist only
excludes shells and generic interpreters. A CLI can exit or change state between
validation and input. The checks before typing and
before Enter narrow but cannot remove that race. They cannot reliably detect a
permission prompt, queued input, the model's current task, or hidden background
writers. The user must inspect the real sessions and confirm readiness. A CLI restarted
inside a surviving pane can reuse its pane identity and command name; this
scaffold does not authenticate the CLI conversation/session UUID. Re-register
after restarting a worker and reconcile any outstanding turn.

The per-worktree hold prevents this controller from sending a second command into
a worktree while one is in flight or its delivery is uncertain; other worktrees
proceed independently. Between clean deliveries the only gate is the per-send
readiness confirmation. Nothing prevents desktop typing, filesystem edits, or agent
subprocess writes.
A malicious agent running as the same Unix user could access the controller's
files or tmux socket. There is no hostile-agent isolation in this design.

Run one backend process per store. Multi-process recovery, distributed locks, and
remote worker hosts are outside this starter. Do not use it unattended. Do not
expose a development server, public Funnel endpoint, or public reverse proxy.

The token has full owner access. There are no roles, password recovery, per-device
revocation, hardware-backed credentials, or tested rate limits. A production CSP,
dependency security review, access-token lifecycle, and phone pairing need work
before the private-phone milestone can be considered accepted. Basic response
headers are included, but do not amount to a completed security audit.

## Sensitive data and retention

SQLite is outside the source tree, with mode-specific stores under the configured
data directory. Directory/file modes are restricted. Command text, repository
paths, and audit errors are persisted in plaintext; raw snapshots are not persisted.
There is no automatic retention cleanup yet. Protect host backups, and do not put
secrets into prompts. SQLite WAL/SHM files are part of the sensitive store.

Test fixtures use an obvious repeated-character token only in mock tests. Never
copy that test credential into a real configuration. Verify that `.env.local`,
SQLite files, and logs are excluded before publishing any repository or ZIP.

## Before private phone access

Complete local acceptance, the dependency/build checks, and a security review.
Use Tailscale Serve over HTTPS with a narrowly restricted tailnet policy. Keep the
application token and explicit origin checks in addition to network controls.
Do not rely on forwarded identity headers without independently designing and
verifying that trust boundary. See [TAILSCALE.md](TAILSCALE.md).
