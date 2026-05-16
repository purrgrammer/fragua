---
status: proposed
---

# Proposal: per-parent SSE stream for descendant run events

> Status: draft

## Problem

`RunDetail` uses a global `feedAtom` (the Home-page activity feed) to detect when a child run posts a new message, so it can bump `descendantRefreshToken` and re-fetch the sub-run list. Since `fact.message_appended` was removed from `FEED_EVENT_KINDS` (trimming the feed allowlist), child-message ticks no longer fire between child lifecycle boundaries — the token only updates on child lifecycle events (`run_started`, `run_completed`, etc.).

This is an accepted regression for the pre-release phase: the old behaviour was shipping high-frequency bookkeeping events through the global feed solely to drive a single `useMemo` in one route, which is an architectural mismatch.

## Proposed fix

Add a dedicated SSE endpoint (e.g. `GET /runs/:id/descendants/stream`) that the server fans out from the parent's child-run set. The client subscribes to this per-parent stream instead of piggybacking on the global feed atom. The stream carries only the event types needed for descendant refresh (lifecycle + message_appended) and is scoped to runs whose `parent_run_id` matches `:id`. This avoids polluting the operator feed while restoring sub-message responsiveness for the RunDetail conversation view.
