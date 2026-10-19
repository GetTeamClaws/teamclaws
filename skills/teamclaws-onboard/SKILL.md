---
name: teamclaws-onboard
description: Help a user connect to TeamClaws, choose workspaces to pair, and optionally move and run projects. Use for install-and-connect requests, not status-only questions.
---

# Connect to your TeamClaws workspace

This is the shared conversation workflow for:

> Install teamclaws@latest, read its agent skills, and help me connect to my cloud workspace.

Use the installed official CLI and the skills shipped beside this file. Do not
borrow model/provider credentials. A status-only request uses the login or pair
skill's read-only status operation and stops; it does not start onboarding.

## Sign in

Run `teamclaws auth status --json`. If signed in, confirm the returned account
and continue without another login. If signed out, follow
[teamclaws-login](../teamclaws-login/SKILL.md): start `teamclaws login --json`
without an email unless the user explicitly supplied one. Immediately show the
returned `login_browser_required.url` as **Sign in to TeamClaws** in chat and
explain:

“Use your TeamClaws account. If you already have a workspace, use the account
that has access to it. This may use a different email from your AI assistant
account.”

Keep login running while the user signs in. Confirm the account only after
`login_complete` and exit 0. Denial, expiry, and network failure are distinct
failures; report the actual result without claiming success.

## Choose workspaces

Run `teamclaws servers list --json`. Use only a successful `servers_list` event;
errors are not empty inventories. Display aliases, retaining `server_id` for
commands. Explain readiness separately from ownership.

If discovery emits `server_metadata_prompt`, show its question and explain that
the owner can always change the server's name and description later. Ask for the
desired values if the user wants to edit them; run `teamclaws servers update
<server-id> --name <text> --description <text> --json` only after their answer.
Either flag may be omitted to keep that field unchanged. This question is
remembered once per owner and server across devices, including a decline, so
deliver it when received. Never offer this edit for a shared server whose
`can_edit_metadata` is false, and never infer ownership from an alias or role.

- `discovery_state: no_workspaces` means the broker confirmed zero workspaces
  accessible for pairing, including owned workspaces still being prepared.
  Direct the user to https://teamclaws.com/app/ to purchase a workspace, then
  resume discovery when they are ready.
- `not_ready` means workspaces exist but none listed can be paired yet. Explain
  their state and offer to check again when ready; do not suggest another purchase.
- `unknown` means the broker did not supply a complete inventory count. An empty
  list does not prove an empty account. Ask the user to check their workspaces at
  https://teamclaws.com/app/; only if they confirm they have none, direct them to
  purchase there. Do not claim inventory support is deployed from local code alone.
- With one pairing-ready workspace, name its alias and ask, “Would you like to
  pair with **[alias]** now?” Never automatically pair it.
- With several, list aliases and ask, “Would you like to pair with any of these
  now?” If aliases repeat, distinguish them using their workspace addresses.

For each selected workspace, follow [teamclaws-pair](../teamclaws-pair/SKILL.md)
with its stable identifier. A prior explicit selection already authorizes that
pairing; do not ask again. Verify existing pairing status before recreating a
completed pairing. An unreachable workspace is not proof it needs re-pairing.
Complete the user's selected pairings, then offer additional workspaces until
they say they are finished. Preserve remaining selections when browser approval
requires ending a turn; resume after verified completion.

## Projects

When the user finishes choosing workspaces, ask:

“Would you like to move any projects to your TeamClaws machine?”

If yes, follow [teamclaws-project](../teamclaws-project/SKILL.md). Ask which
project only if unspecified, and which paired destination only if multiple are
possible and the choice is missing. Transfer consent is not publication consent.
For service-based projects, offer to get them running; public and private are
both live hosting choices. Do not start chat, transfer, or deployment merely
because pairing succeeded.
