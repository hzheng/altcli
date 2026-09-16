# Native iOS client: reserved

No Swift source, Xcode project, signing configuration, or app target is included.
The current iPhone experience is the responsive web console through Tailscale.

A later native app would read snapshots, issue explicit commands, inspect delivery
state, and submit human decisions to the host controller's versioned HTTP API.
The host still owns tmux access, persistent command records, and any future relay
coordination. Suspending the iPhone app must not move ownership onto the client.

Start from `../shared/openapi.yaml` and `../web/src/contracts/api.ts`. Decide
pairing/authentication, secure credential storage, push notifications, background
behavior, accessibility, and Swift model generation before implementation.
Do not assume automatic TypeScript-to-Swift translation or a local iOS agent runtime.
Do not copy TimedGoal's standalone database/authority design into this project.
