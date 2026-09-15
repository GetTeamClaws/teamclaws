---
name: teamclaws-login
description: Sign the official TeamClaws command-line client in, inspect its safe login status, or sign this computer out without exposing login credentials.
---

# TeamClaws command-line login

Use the official executable:

```text
npx teamclaws login --json
npx teamclaws login owner@example.com --json
npx teamclaws auth status --json
npx teamclaws logout --json
```

Login uses OAuth 2.0 Device Authorization Grant against www.teamclaws.com. The
next owner-facing line is `verification_uri_complete`. Optional email is a bind
sent to TeamClawsdeploy, not identity asserted by this process. Never transfer a
model or harness token into this process. The command-line client stores its own
protected login credential locally.

Only treat the fixed structured events as safe. Never expose access tokens,
refresh tokens, device codes, cookies, or authorization headers.

Logout always removes the local command-line login credential. A
`local_only_warning` status means local logout succeeded but remote revocation
could not be confirmed. Completed Clawgate workspace credentials are not
deleted by logout.
