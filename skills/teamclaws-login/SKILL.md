---
name: teamclaws-login
description: Sign the official TeamClaws command-line client in, inspect its safe login status, or sign this computer out without exposing login credentials.
---

# TeamClaws command-line login

For install-and-connect requests, follow
[teamclaws-onboard](../teamclaws-onboard/SKILL.md) for the conversation sequence.
A status-only request runs only `teamclaws auth status --json` and stops.

Use the official executable:

```text
npx teamclaws login --json
npx teamclaws login owner@example.com --json
npx teamclaws auth status --json
npx teamclaws logout --json
```

Login uses OAuth 2.0 Device Authorization Grant against www.teamclaws.com. The
next owner-facing message must link `login_browser_required.url` with the label
**Sign in to TeamClaws** and include `account_guidance`. Keep the command running
while the user signs in; do not restart it while awaiting approval. Confirm the
returned account after `login_complete` and exit 0, not after opening a browser.
Start without an email unless the user supplies one. Optional email is a bind
sent to TeamClawsdeploy, not identity asserted by this process. Never transfer a
model or harness token into this process. The command-line client stores its own
protected login credential locally.

Only treat the fixed structured events as safe. Never expose access tokens,
refresh tokens, device codes, cookies, or authorization headers.

Logout always removes the local command-line login credential. A
`local_only_warning` status means local logout succeeded but remote revocation
could not be confirmed. Completed Clawgate workspace credentials are not
deleted by logout.
