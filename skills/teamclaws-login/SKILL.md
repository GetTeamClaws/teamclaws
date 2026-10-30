---
name: teamclaws-login
description: Sign the official TeamClaws command-line client in, inspect its safe login status, or sign this computer out without exposing login credentials.
---

# TeamClaws command-line login

For install-and-connect requests, follow
[teamclaws-onboard](../teamclaws-onboard/SKILL.md) for the conversation sequence.
A status-only request runs only `teamclaws auth status --json` and stops.

Before starting browser login, explain that the user will sign this computer's
TeamClaws command-line client into their TeamClaws account through the browser.
This connects the client to their account; workspace selection and browser
pairing approval come next when they are connecting a workspace. If onboarding
already explained the process, use a short transition into this step. Give the
approval link with that context, never as an unexplained authorization request.

Pairing connects this computer to the workspace. It does not add a person as a
workspace user; user membership is a separate privilege.

Use the official executable:

```text
npx teamclaws login --json
npx teamclaws login owner@example.com --json
npx teamclaws auth status --json
npx teamclaws logout --json
npx teamclaws logout --revoke --json
```

Login uses OAuth 2.0 Device Authorization Grant against www.teamclaws.com. The
next owner-facing message must link `login_browser_required.url` with the label
**Sign in to TeamClaws** and include `account_guidance`. Keep the command running
while the user signs in; do not restart it while awaiting approval. Keep your
turn active and use the execution tool's wait/read operation on the same process
handle. Do not require an "I approved" or "done" message. If the execution
environment requires yielding, use a supported automatic completion callback or
wakeup that preserves the process; report a limitation if neither is possible.
Confirm the returned account after `login_complete` and exit 0, then immediately
resume the authorized onboarding or pairing task. Denial, expiry, cancellation,
and failure end the attempt; report the result without automatically restarting.
Start without an email unless the user supplies one. Optional email is a bind
sent to TeamClaws, not identity asserted by this process. Never transfer a
model or harness token into this process. The client stores an authorization ID
and protected local signing key; temporary OAuth tokens are discarded.

Only treat the fixed structured events as safe. Never expose access tokens,
refresh tokens, device codes, cookies, or authorization headers.

Ordinary logout removes the local authorization reference. Use `--revoke` only
when the user asks to revoke this CLI authorization at TeamClaws; the CLI waits
for confirmation before removing its local reference. If remote revocation is
uncertain, report that uncertainty and retain the local reference. Completed
Clawgate workspace credentials are not deleted by logout, but old pairings
without authorization binding require re-pairing.
