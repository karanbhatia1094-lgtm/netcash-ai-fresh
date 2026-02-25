# Profit Guardrails Autopilot (MVP)

## Objective
Prevent avoidable ad-spend burn while safely scaling high-confidence winners using a net-cash-first decision model.

## Core Inputs
- Campaign performance (real ROAS, net cash, source/campaign metadata)
- Data quality summary:
  - `% mapped orders`
  - `invalid UTM/campaign IDs`
  - `missing spend rows by source/date`
- Connector sync freshness lag

## Decision Logic
- Compute one confidence score per run using quality + freshness penalties.
- Create recommendations:
  - `throttle`: for negative net cash or very weak real ROAS
  - `scale`: for strong real ROAS + positive net cash + adequate confidence
- Gate action creation by confidence threshold.

## Modes
- `dry_run`: compute and store recommendations only.
- `apply`: also create campaign action items (reversible guidance with rollback notes).

## Storage
- `profit_guardrail_run`
- `profit_guardrail_decision`
- Indexed by `shop + created_at` and `run_id + created_at` for quick drill-down.

## Surfaces
- API: `GET/POST /api/autopilot/guardrails`
- Scheduler: `GET/POST /api/autopilot/cron` enqueues `profit_guardrails_run` jobs
- UI: `/app/autopilot`
  - run controls (days, max actions, mode)
  - confidence + quality snapshot
  - source-level before/after net-cash impact panel
  - recommendations table with rollback and expected impact
  - one-click rollback action creation

## Safety Principles
- No blind automation: apply mode is explicit per run.
- Confidence-aware: low-confidence data yields advisory output only.
- Reversible actions: each recommendation includes rollback guidance.
