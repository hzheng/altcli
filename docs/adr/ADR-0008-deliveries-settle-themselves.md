# ADR-0008: Clean deliveries settle themselves; only uncertainty needs a human

**Date:** September 15, 2026  
**Status:** Selected for the scaffold  
**Amends:** ADR-0003's "keep the reservation after transport success" and its
release step

## Context

ADR-0003 held a worktree after every delivered command until the human pressed
**Review & release turn**, behind a confirmation dialog. In real use this was one
extra click and one popup per relay, and it carried no information: the very next
send already requires the readiness box, "the target is at an empty input prompt,
no permission dialog is active, and no other agent is writing", which is the same
attestation. The release step earned its place only when the transport could not
say whether the text landed.

## Decision

- A `delivered` command settles its worktree immediately (`releasedAt` is set by
  the controller). The per-send readiness confirmation is the human's
  reconciliation of the previous turn.
- An `uncertain` delivery (transport failure after typing began, or a backend
  restart mid-send) keeps its worktree held until a human presses **I checked the
  terminal**, which calls the same `/control/release` endpoint. Nothing is resent.
- In-flight commands (`recorded`, `sending`) hold the worktree for the seconds they
  take; a second send in that window is refused.
- Registration and pair changes are refused only while a worktree is held.
- No `window.confirm` anywhere. Removing a registration or a pair is an inline
  two-step (Remove, then Confirm or Keep). The uncertain-delivery acknowledgement
  is a plain button next to the explanation.
- Command history no longer shows a Reserved/Released column; an uncertain row
  shows when it was acknowledged.

## Consequences

Two clicks fewer per relay and no modal dialogs. The remaining safety properties
are unchanged: UUID duplicate suppression, durable uncertainty, no replay,
identity re-check before typing and before Enter, and one writing command per
worktree at a time. What is given up is the forced pause between a delivery and
the next send in the same worktree; the readiness box is that pause now. The mock
adapter treats the exact instruction `mock:uncertain` as a transport failure so
the browser tests can exercise the acknowledgement path.
