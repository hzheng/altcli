# ADR-0007: tmux by default, input on, mock as a test adapter

**Date:** September 15, 2026  
**Status:** Selected for the scaffold  
**Amends:** ADR-0002's mock default; ADR-0003's separately opt-in real input

## Context

The scaffold started in a simulated console (`CODERCREW_ADAPTER=mock`) with real
input off, so a first-time user saw fake panes and had to edit two environment
variables and restart before the product did anything. The mock adapter exists so
the browser tests and UI work can run without a tmux server; it is a test fixture,
not a first screen.

Every send already requires a registered pane, a fresh identity check against tmux,
and the per-command readiness confirmation. The global input switch added a fourth
gate that mostly produced confusion ("why is Relay disabled?").

## Decision

- `CODERCREW_ADAPTER` defaults to `tmux`. `mock` remains selectable for tests and
  development and is documented as such; it never touches a terminal.
- `CODERCREW_ENABLE_INPUT` defaults to `true`. Setting it to `false` turns the console
  read-only (captures only); the console says so. It cannot be changed from the
  browser.
- The first screen in tmux mode is the add-pane panel. With no tmux server it says
  so and shows the command to start a CLI in tmux; with panes it lists them.
- Registration is project-first. The first selected pane (or an explicit choice
  from the repositories where CLIs are running) fixes the worktree root; every pane
  registered in that panel is stored with that root, and panes outside it are shown
  as not selectable. Opened from a project view, the panel is locked to that project
  until **Change**. The panel stays open until the project has two registered agents,
  then hands over to the console. A relay between two repositories is not something
  the console offers.

## Consequences

`docs/TESTING.md` level 3 no longer restarts between read-only and input. The
cautious path is still available by adding `CODERCREW_ENABLE_INPUT=false` for the
first run. An existing `web/.env.local` written by the earlier setup still pins
`mock` and `false` and must be edited or regenerated.
