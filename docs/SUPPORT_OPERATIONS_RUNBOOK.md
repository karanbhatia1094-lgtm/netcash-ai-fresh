# Support Operations Runbook

## Severity Matrix
- P1: Full outage or data unavailability.
- P2: Major feature degradation with workaround.
- P3: Non-blocking bug affecting workflow quality.
- P4: Minor issue or enhancement request.

## Response Targets
- P1: acknowledge in 1 hour.
- P2: acknowledge in 4 hours.
- P3: acknowledge in 1 business day.
- P4: acknowledge in 2 business days.

## Escalation Flow
1. Support triage validates scope and affected shops.
2. Engineering on-call engaged for P1/P2 immediately.
3. Owner escalation if unresolved beyond SLA target.

## Daily Operational Checks
- `/api/monitoring/overview`
- `/api/monitoring/alerts`
- `/api/data-quality/summary?days=30`
- `/api/security/secrets`
- `/api/autopilot/cron` enqueue health (expected queued jobs)
- `/api/jobs/worker` processing health (expected processed jobs > 0 during backlogs)

## Customer Communication
- Use known-issues page for active incidents.
- Provide ETA and workaround in every P1/P2 response thread.
