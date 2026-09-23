# Private iPhone access

This is a planned deployment path, not a record of physical-device acceptance.
The first mobile client is the responsive web interface; ios/ remains reserved.

Finish [local acceptance](SETUP.md) and the [security review](SECURITY.md). The
backend must run on the same awake host and Unix user as the tmux workers. Restrict
tailnet access to the intended user/devices. Do not expose next dev publicly.

```bash
cd web && npm run build && npm run start
```

Keep the backend bound to 127.0.0.1:8787. Inspect existing Serve configuration before
changing it; do not reset unrelated routes.

```bash
tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Use the exact HTTPS origin returned by Serve and add it to
ALTCLI_ALLOWED_ORIGINS without a path or trailing slash. Restart the backend.
Connect the iPhone through Tailscale and open that address in Safari. Supply the
owner token through the form, never a URL. A full reload requires the token again.

Use Serve, not public Funnel. Serve does not start/supervise the Node service,
keep a sleeping host awake, or create coding-agent sessions.

## Server-owned run behavior

Locking, closing or disconnecting a browser does not pause an armed server run.
Use Pause before manual takeover. Multiple clients share the persisted turn budget
and execution owner; changing the displayed project does not change routing.
A backend restart pauses owned runs without replay and requires human reconciliation.
Unknown lifecycle/background evidence pauses rather than being treated as idle.

Check accidental double taps, stale output, keyboard behavior, network changes,
phone screen locking, page reload, simultaneous desktop access, and uncertain
requests. Verify that only one next turn is scheduled for a completion observed
on both devices. Explicit takeover must not resend a command or mark task success.

Chromium mobile viewport tests are not a substitute for Safari on an actual
phone. Record the exact commit, host/CLI versions and observations before claiming
private-phone acceptance. See the official
[Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
