---
description: Check provider usage and account headroom so you can pace and rotate in time.
---

# Usage — see current usage and headroom so you can pace

A thin, portable skin over heddle's own usage reporting so you can check spend and account headroom
before it becomes a problem. It reports and advises; it never changes anything.

## 1. Provider usage totals

- Run `heddle usage` — per-provider dispatch counts and token totals.
- Read it: which provider is carrying the load, and whether the mix is healthy. heddle's whole point
  is spreading labor across providers rather than leaning on one, so a single provider dominating is a
  signal to rebalance.

## 2. Account headroom / rotation

- Run `heddle account pick --explain` — the healthiest addressable account and WHY.
- Use it to judge whether the active account is near a limit and a rotation is due.

## 3. Scoping

- `heddle usage --since <iso>` for a specific window (e.g. `--since 2026-09-01T00:00:00Z`).
- `heddle usage --json` for machine-readable output.

## 4. What to do with it

- Provider over-concentrated → prefer dispatching by task class to spread the load.
- Account near its limit → plan a rotation at a clean boundary: finish, commit, and push (and post a
  handoff) FIRST, so a rotation loses nothing.
