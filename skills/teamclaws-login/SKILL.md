---
name: teamclaws-login
description: Sign the official TeamClaws command-line client in, inspect its safe login status, or sign this computer out without exposing login credentials.
---

# TeamClaws command-line login

## Authorized new-account signup

The purpose of email signup is to let authorized agents create accounts without
human intervention. With full permission to create the account and read the
chosen inbox, proceed yourself; do not request another confirmation, require
browser sign-in, or ask a human to retrieve an accessible code. Full permission
does not supply missing tools or override an explicit restriction. A new customer
does not need an existing TeamClaws account or workspace.

If account creation and reading the supplied inbox are authorized, run `teamclaws signup <email> --json`. A
`signup_pending` event is conditional acceptance, not proof of mail delivery or
account creation. For eligible mailboxes, read the 15-minute single-use code.
Run `teamclaws signup verify --code-stdin --json` and supply the code plus a
newline using the execution tool's non-TTY stdin. If your tool only runs shell
commands, replace EMAIL_CODE with the emailed code and run this POSIX heredoc
immediately:

    teamclaws signup verify --code-stdin --json << 'TEAMCLAWS_CODE'
    EMAIL_CODE
    TEAMCLAWS_CODE

Keep the code out of command arguments, customer-facing chat, and test reports.
The CLI handles its private verifier and machine key. Use your authorized email
tool to read the code.

The same commands can reconfirm only accounts whose access from this signup
flow was rejected; the backend checks eligibility and issues new authorization.
Start signup again after the denial and use that request's new emailed code;
do not reuse an earlier code or pending request for reconfirmation.
They are not email login for ordinary existing accounts. An active CLI login
blocks signup. Its normal status check may clear an authoritatively revoked
login, but preserves state and stops on network errors. Do not automatically
retry failed or unconfirmed signup. If an account was created and the successful
exchange response was lost, use the existing browser-login path for recovery.
After `login_complete` and exit zero, immediately run
`teamclaws workspaces list --json`. If the user wants to start the Lite trial,
show the claim terms in the onboarding skill and obtain authorization before
claiming. After a successful claim, run the list command again. Show the
workspace state and, while building, report `status_since` as “Building since”
when available. Continue preparing the
user's project while it becomes ready. Use the selected workspace, or ask which
workspace should run the project when the destination is ambiguous. Follow the
onboarding skill if the expected workspace is missing.

## Existing account browser login

For install-and-connect requests, follow
[teamclaws-onboard](../teamclaws-onboard/SKILL.md) for the conversation sequence.
A status-only request runs only `teamclaws auth status --json` and stops.

Before starting browser login, explain that the user will sign this computer's
TeamClaws command-line client into their TeamClaws account through the browser.
This connects the client to their account so the agent can find their workspace
and get their project running. If onboarding
already explained the process, use a short transition into this step. Give the
approval link with that context, never as an unexplained authorization request.

After login, authorized shell commands can run on a selected workspace without
a saved device pairing. Do not start pairing for a shell-only request.

Pairing connects this computer to the workspace. It does not add a person as a
workspace user; user membership is a separate privilege.

Use the official executable:

```text
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
resume the user's selected task. Denial, expiry, cancellation,
and failure end the attempt; report the result without automatically restarting.
An email address is required. If the user has not provided their TeamClaws email,
ask for it and wait for their answer before starting login. Do not guess it from
their AI assistant account or invent an address. Pass the supplied email to
`teamclaws login <email> --json`. The email binds approval to that account; it is
not identity asserted by this process. Never transfer a
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
