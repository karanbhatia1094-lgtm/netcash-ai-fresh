# Netcash.ai Legal and Compliance Policy (Pilot)

## 1) Privacy Policy
- Publish a public privacy policy URL before pilot launch.
- Clearly document data categories collected:
  - Shopify order and customer transaction metadata
  - campaign/source attribution fields
  - connector OAuth tokens and sync metadata
- Document subprocessors and hosting regions.

## 2) DPA (Data Processing Addendum)
- Offer a DPA for merchants processing personal data through Netcash.ai.
- Include:
  - controller/processor roles
  - security controls
  - data breach notification commitment
  - subprocessor change process

## 3) Data Retention Policy
- Define per-entity retention windows:
  - order and attribution analytics
  - sync/job logs
  - alert and audit records
- Support per-shop retention overrides where required by contract or law.

## 4) Deletion Flow Per Shop
- Trigger deletion on:
  - merchant account request
  - app uninstall webhook
- Deletion requirements:
  - remove connector credentials/tokens
  - remove shop-linked analytics rows
  - remove pending queue jobs for that shop
  - return deletion confirmation with timestamp

## 5) Pilot Compliance Controls
- Keep `ROLLOUT_CANARY_ONLY=true` during pilot.
- Keep risky features on canary rollout modes.
- Review compliance checklist weekly during pilot until GA.
