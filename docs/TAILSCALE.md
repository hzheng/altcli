# Private iPhone access: planned deployment path

This guide documents the intended path. No Tailscale setting was changed while
creating the starter, and a real iPhone/Tailscale session has not been tested.
The first mobile client is the responsive web interface. `ios/` remains reserved.

## Preconditions

Finish the local acceptance checklist and security review. Run the backend on the
same awake host and Unix user as the registered tmux sessions. The phone and host
must be signed into the intended tailnet, and its access policy must restrict this
service to your intended identity/devices.

Do not expose `next dev`. Build and run the production application:

```bash
cd web && npm run build && npm run start
```

The backend stays bound to `127.0.0.1:8787`.

## Serve privately

On the host, using the existing Tailscale CLI installation:

```bash
tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Use the exact HTTPS address returned by Serve, not a guessed device domain.
Update `CODERCREW_ALLOWED_ORIGINS` in `web/.env.local` to include that exact
origin, without a trailing slash or path. Example placeholder only:

```dotenv
CODERCREW_ALLOWED_ORIGINS=http://127.0.0.1:8787,http://localhost:8787,https://your-host.your-tailnet.ts.net
```

Restart the backend after changing its environment. Connect the iPhone through
Tailscale and open the reported HTTPS address in Safari. Supply the application
token through the login form, never through a query parameter. The token currently
stays only in memory and must be re-entered after a full page reload.

Use **Serve, not Funnel**. This application is not intended to expose terminal
control to the public internet. Serve's background configuration does not install
or supervise the Node application, keep a sleeping Mac awake, or run your coding
agents for you. Host startup/service management is a separate task. Inspect an
existing Serve configuration before modifying it; do not reset unrelated routes.

## Phone acceptance

Check target selection, pane reading, accidental double taps, keyboard behavior,
stale or unavailable output, network changes, screen locking, browser reload,
uncertain command delivery, and its acknowledgement. Confirm that opening
another tab does not create duplicate agent processes or bypass reserved ownership.

A browser disconnect must never stop the worker sessions or automatically resubmit
a command. Always reconcile uncertain delivery against the host's command history
and actual terminal. Mobile viewport tests included in this starter use Chromium;
they are not a substitute for Safari on an actual iPhone.

See [SECURITY.md](SECURITY.md) and the official
[Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
