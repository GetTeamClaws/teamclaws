# TeamClaws client

The official TeamClaws command-line client pairs a filesystem-capable computer
with a TeamClaws workspace and stores the resulting Clawgate credential on that
computer. The command-line client and its agent skills ship together in this
package.

Pairing connects this computer to the workspace. It does not add a person as a
workspace user; user membership is a separate privilege.

## Requirements

- Node.js 22 or newer
- Windows 11 or Windows Server 2022 or newer, macOS 14 or newer, or a modern
  GNU/Linux distribution with glibc 2.28 or newer
- x64 or ARM64

## Installation

Check `node --version` first. If it is below 22, upgrade Node.js to version 22
or newer before installing. The install script rejects Node.js below 22 during
an ordinary npm install. npm's `--ignore-scripts` or an installer policy that
disables lifecycle scripts bypasses this install check; the CLI still refuses
to run on Node.js below 22. `--engine-strict` also enforces the declared engine
requirement without changing global npm settings.

Install the published CLI:

```text
npm install -g teamclaws@latest
teamclaws --version
```

To install a downloaded release tarball:

```text
npm install -g ./teamclaws-1.0.1.tgz
teamclaws --version
```

GitHub source ZIPs must be built before use; they are not npm installers.

## Agent onboarding

> Install teamclaws@latest, read its agent skills, and help me connect to my cloud workspace.

Start with [teamclaws-onboard](skills/teamclaws-onboard/SKILL.md). For a global
installation, `npm root -g` locates the package root; read
`teamclaws/skills/teamclaws-onboard/SKILL.md` beneath it. The package contains one
shared workflow for login, alias-based user-selected pairing (including a single
workspace), additional pairings, project transfer, and optional public/private
live hosting. Login and pairing mechanics remain in their respective skills;
[teamclaws-project](skills/teamclaws-project/SKILL.md) covers project work through
the existing paired shell. Status-only requests do not start onboarding.

Before any browser authorization, the agent explains the process: sign this
computer's CLI into the user's TeamClaws account through the browser, choose a
workspace and pair with that server, then choose useful
work and set up its environment on the server. It explains the purpose and access
of each approval before presenting a link, adapting to steps already completed.
The conversation starts with that context rather than an unexplained request to
click an authorization link.

Pairing completes automatically when TeamClawsDeploy confirms the account owns
the workspace or is a superuser in its access group. Browser approval is shown
only when the target reports that approval is pending.

Agents keep their turn and the original login/pairing process alive while the
user approves in the browser, monitor its output, and continue automatically
after terminal success. No "I approved" message is needed. An execution
environment that must yield needs a supported completion callback or automatic
wakeup that preserves the process; a saved skill alone cannot supply that
runtime capability.

After verified pairing, the agent refreshes `teamclaws servers list --json` and
presents each workspace's name, description, and readiness in a Markdown list or
code block, or plain text with one option per line. It then suggests concrete
uses tied to the user's work and continues an already authorized task. An
explicit request to stop at pairing takes precedence. Pairing and status-only
requests never implicitly authorize deployment, sharing, or a remote chat.

The bundled [workspace capability guide](skills/teamclaws-onboard/references/workspace-uses.md)
explains complete jobs, long-running services, external APIs and servers, agents
with browser access, development and production hosting, and sharing. Agents
should use it to propose relevant work in the user's vocabulary and verify each
selected host's prerequisites before promising a capability is ready.

### Onboarding output contract

Existing event names and schema version remain unchanged. The
`login_browser_required` event provides the safe `url`, a `label` of
`Sign in to TeamClaws`, and `account_guidance`. Display these immediately while
login keeps running. Signed-out `auth_status` includes the non-executing
`login_command: "teamclaws login <email> --json"`; status never starts device authorization.

When approval is pending, `pairing_browser_required` supplies the safe approval
URL and public `user_code`. Automatic pairing emits no browser approval event.
Some hosts include a validated `agent_action` with the legacy type
`deliver_and_stop`. The agent displays its approval message and continues
monitoring the original process; that field does not end the agent's turn. The
CLI directly polls at the host-provided interval, handles pending and slow-down
responses, and verifies the approved credential before `pairing_complete`.
Success requires that terminal event and exit 0. Denial, expiry, cancellation,
and errors end the attempt without automatic restart. An interrupted output
stream leaves the outcome unconfirmed and must be reconciled before retrying.

### Approval continuation verification

The development tests exercise pending approval, automatic credential completion,
denial, expiry, cancellation, and a referenced polling timer. The delayed
approval process test runs the compiled pairing client with stdin disconnected:
a fixture simulates the owner's later browser approval, and the same child
process must emit exactly one `pairing_complete` and exit 0 without a chat reply.
Package validation also checks that the capability reference ships with the
skills and matches the source bytes by SHA-256.

For acceptance in an agent environment, load the updated bundled skills, select
an authorized test workspace, and start pairing. Confirm the approval link is
visible while the turn stays active. Approve in the browser without sending a
chat message. The agent must observe terminal success, refresh and format the
workspace inventory, and continue the authorized task or suggest a relevant next
action. Repeat denial and expiry to confirm it stops without creating another
request. Test a required-yield environment separately if automatic wakeup is
used. Local CLI tests establish process behavior, not automatic loading or
compliance in every agent environment.

`servers list` requests `GET /api/cli/v1/servers/?include_inventory=1&include_description=1&include_editable_metadata=1&include_subscription=1`. Updated
brokers return `servers` and `workspace_count`: the count of all non-deleted
owned and eligible shared workspaces, including those without a hostname yet.
Individual server entries retain aliases, stable IDs, status and `pairing_ready`.
When supported, they also include the server description. Older brokers may
omit descriptions; nonempty descriptions appear under each readable list entry.
The editing opt-in adds `custom_alias` (the owner's saved name, distinct from a
fallback display name) and `can_edit_metadata`. Older brokers may omit these.
Older brokers may omit the count; the CLI reports it as null and never infers
an empty account from an empty filtered list.

Subscription inventory (2026-11-04) adds optional `tier_name`, `is_free`, and
`free_expires_at` fields. Null values mean no subscription information or no
free expiration deadline, as applicable. The CLI displays the tier and free
deadline and starts warning seven days before free access expires, including
an expired warning at or after the deadline. JSON `servers_list` events include
the subscription fields and a `warnings` array with server ID, warning code,
deadline, and message. Warnings are evaluated when inventory is displayed;
there is no background polling.

`include_subscription=1` preserves compatibility with older clients whose list
validators reject extra fields. This compatibility opt-in can be retired when
support for those clients ends. This CLI accepts older responses without the
subscription fields and ignores unknown inventory and server-entry fields,
while continuing to validate every recognized field it consumes.

The `servers_list` event adds `workspace_count` and `discovery_state`:
`no_workspaces` only for a verified count of zero, `ready` when any listed
workspace is pairing-ready, `not_ready` when workspaces exist but none is ready,
and `unknown` for an empty legacy response without a count. Discovery errors
remain error events. A verified empty account uses https://teamclaws.com/app/ to
purchase a workspace. Existing owners whose machines are being prepared do not
need another purchase. Targetless pairing requires explicit selection even for
one result; agents present aliases and pass only user-selected stable IDs.

During onboarding or the post-pairing inventory, agents suggest a recognizable
name for the selected editable workspace if its displayed alias matches
`workspace-` followed by 12 lowercase hexadecimal characters, such as
`workspace-07d9e4893885`. Suggestions should reflect the user's project or intended
use and wait for their choice before renaming. A customized display name is kept
even when its hostname still follows that pattern. Combine this suggestion with
any metadata prompt already being shown rather than asking twice.

Owners can edit their server's user-defined name and description:

```text
teamclaws servers update <server-id> --name "My server" --description "What this server is for"
```

Provide either flag or both. Omitted fields stay unchanged; an empty string
clears a field. The name updates the server alias, preserving its system name
and workspace address. Names are limited to 100 characters and new descriptions
to 2000. The API enforces ownership; shared access, staff, and superuser roles
do not grant editing rights to someone else's server.

When `servers list` or targetless pairing first discovers an owned server with
no user-defined name or description, the CLI asks once whether to set them and
explains the command to edit them later. This prompt is remembered per owner and
server across devices, including a decline. In `--json` mode, the CLI emits a
`server_metadata_prompt` event for the agent to show the user, followed by the
normal result. Agents must ask the question and wait for the user's answer
before running the edit command. Plain-text commands without an interactive
terminal do not consume the prompt. The backend atomically claims the prompt;
a crash after that claim may consume it before it is displayed.

## Commands

```text
npx teamclaws login <email>
npx teamclaws auth status
npx teamclaws logout
npx teamclaws logout --revoke
npx teamclaws servers list
npx teamclaws pair status <server-identifier-or-canonical-workspace-address>
npx teamclaws pair
npx teamclaws pair <server-identifier-or-canonical-workspace-address> [--no-open]
npx teamclaws shell <target> --command <text> [--json]
npx teamclaws users add <target> <email> --role <user|staff|superuser> [--sudo] [--json]
npx teamclaws chat start <target> --message <text>
npx teamclaws chat send <target> --session-id <uuid> --message <text>
npx teamclaws chat watch <target> --session-id <uuid> --request-id <uuid>
```

Human-readable output is the default. Add `--json` for the strict, versioned,
newline-delimited JSON event stream intended for automation.

Pairing (including explicit targets), server listing, pair status, chat, and shell
require a saved TeamClaws CLI authorization and its local machine key. Run
`teamclaws login <email>` first. Email is required; agents must ask for the user's TeamClaws email if it has not
been provided before starting login. Login uses the browser approval to bind a new key to
your TeamClaws account; the CLI discards the temporary OAuth tokens. Later
commands sign fresh proofs without repeating browser approval. Missing or
revoked authorization exits with code 3 in both human and JSON modes. Help,
version, login, auth status, and logout remain available. Saved workspace
credentials are preserved when login is required, but pairings made before this
authorization protocol must be paired again.

Pairing is broad privileged delegation to the approved workspace. The client
does not request or select scopes, profiles, capability bundles, roles, user
types, or permission labels. TeamClaws, Clawgate, and host policy determine the
authority of the approved credential.

The client never accepts a model or harness access token. An agent that already
discovered a workspace passes only the selected stable server identifier to the
`pair` command.

`pair status` reads the matching protected local workspace credential, obtains
a short-lived target proof for that bound pairing, performs at most one direct
workspace verification with a five-second timeout, reports the result, and
stops. It never starts pairing or loads external-chat resources.

After pairing, `chat start`, `chat send`, and `chat watch` use the protected
workspace credential directly against that exact workspace. They verify the
authoritative versioned handoff, resolve the workspace capability catalog, and
stream only allowlisted durable request events. They never send the workspace
credential through `www.teamclaws.com` or download and execute the generated
Python helper. Use `--client-request-id <uuid>` to safely repeat an uncertain
create request, and use the watch cursors printed in JSON events to resume
monitoring without creating another turn.

## Add a workspace user directly

`teamclaws users add <target> <email> --role user --json` sends a direct request
using the saved paired machine credential and its bound authorization. The role
is required; supported roles are `user`, `staff`, and `superuser`. The server
verifies current owner authority and the shared six-calendar-month machine
authorization deadline. Initial CLI login and pairing remain the normal setup.

This operation requires no agent, AI provider, chat, shell, skill, or browser
session. Missing or inactive credentials return an error without opening a browser.
The result's `requested_role` is the requested access, not a change to an existing
member's role. `invited` means an invitation was sent; access starts after
acceptance. Existing memberships and pending invitations are preserved without
promotion or resend. If a request has an uncertain network outcome, inspect the
invitation status before trying again; the command does not blindly retry it.

The owner can include `--sudo` when inviting a `superuser` to grant full sudo
access after acceptance:

```text
teamclaws users add <target> <email> --role superuser --sudo
```

Omitting `--sudo` requests no sudo grant. The flag is rejected for `user` and
`staff` roles. Sudo follows the existing access-group membership. The CLI
requires the workspace to acknowledge the saved sudo selection before reporting
a new sudo invitation as successful. Existing members and pending invitations
remain unchanged even when the flag is supplied.

### Inspect users and invitation status

```text
teamclaws users list <target> --json
```

This read requires the current machine owner's active paired authorization.
It lists current members separately from pending and accepted invitation
records. An accepted invitation is historical evidence of acceptance; current
membership determines whether the person still has access. An expired pending
invitation is marked expired. Listing sends no invitations and changes no roles,
memberships, or invitation state. It requires a workspace with the users-list API.
When supplied by the workspace, each entry includes its saved `sudo_enabled`
status. An accepted invitation's selection is historical; the current member's
status determines their current access.

## Read chat history without a browser

```text
teamclaws chat history <target> --json
teamclaws chat messages <target> --chat-id <chat-public-uuid> --json
teamclaws chat messages <target> --chat-id <chat-public-uuid> --after-message-id <last-read-id> --json
```

The first command lists chats from the workspace; the messages command reads
their content and later follow-ups. Both commands automatically read every page.
Use `chat_id` from the list or `chat_public_id` from a conversation URL. Save
`latest_message_id` to read only later messages next time.

This access is standard for new and existing pairings. The workspace owner's
agents can read every user's chats on the workspace. Other users' agents,
including superusers' agents, can read every chat belonging to their own user.
Archived, deleted, empty, and browser-created chats are included. There is no
optional history grant or model requirement. These commands do not create chats,
send messages, or mark conversations viewed. Clawgate must include the history
endpoints; older servers return an error rather than an empty history.

`chat list` only lists local request references. `chat watch` only reads responses
to a specific request, so neither command checks for later conversation turns.

## Host shell commands

For authorized workspace administration, first check pairing status with
`teamclaws pair status <target> --json`. If `not_paired`, complete CLI login and pairing
for that workspace before using the shell, following browser approval only when
requested by the CLI. A linked AI provider or
TCChat conversation is not required for paired-shell access; remote chat is a
separate operation.

`teamclaws shell <target> --command <text> [--json]` uses an existing saved
pairing to execute the exact command text on the workspace host. Quote the
command as one local shell argument; quotes, pipes and newlines inside that
argument are preserved. Each request starts in the executing account's home
directory. The command does not log in, pair, or load chat capabilities.

Normal mode forwards stdout and stderr without adding text. JSON mode emits one
object with `stdout`, `stderr`, and `exit_code`. Both modes return the remote
process exit code. HTTP/authentication/transport errors use the existing CLI
error output and failure codes.

The client sends one POST to `/teamclaws-admin/api/shell/` with
`Content-Type: text/plain; charset=utf-8`, never follows redirects, and never
retries execution. The shell path has no command or HTTP operation deadline,
command-size limit, or response/output-size limit. A network failure can leave the
execution outcome unknown; inspect the host before deciding to run it again.

## Local storage

The CLI stores the approved authorization ID, account ID, and public key
reference in its private user directory. The private signing key remains in
Windows CNG or, on Linux and macOS, a separate protected PKCS#8 key file.
Completed workspace credentials are stored by stable server identifier beneath
`~/.teamclaws/clawgate-devices/<server-uuid>.json`. Writes are atomic. Unix
directories use mode `0700` and files use mode `0600`; Windows uses
inheritance-disabled access-control entries limited to the current user and the
Windows system account. Ordinary `logout` removes local authorization access;
`logout --revoke` waits for TeamClaws to confirm server-side revocation before
removing the local reference. Neither command deletes saved pairings.

The package is licensed under the PolyForm Shield License 1.0.0. Paid service
access is enforced by TeamClaws servers, not by the client license.

### Provider and model capabilities

If the workspace confirms `no_provider_paired`, open its `/teamclaws-admin/`
page, choose **Link AI Account**, and connect a provider. For Cursor, choose
**Cursor**, then **My Subscription**, and complete browser authorization.
An unavailable provider status or a transport failure does not prove that no
provider is paired.

Run `teamclaws chat capabilities <target> [--json]` with an existing saved
workspace pairing. It reads the workspace capabilities endpoint with a shared
120-second budget, attempts lasting at most 15 seconds, and pauses of up to five
seconds between retryable failures or inventories with no model choices. It does not
log in, pair, or start a chat. Without a saved pairing it makes no workspace request.

JSON output is one `chat_capabilities` event with `schema_version: 1`,
`status: "success"`, `source: "refresh"`, the safe workspace ID/origin, and
`external_chat_capabilities`. This is a reduced public projection: provider/model
IDs, supported reasoning levels, fast availability, recommendation, capability
read/create/write scopes, identity alias, fast-mode policy and chat limits. Device
credentials, internal identity IDs and unknown server fields are not emitted.
Human output lists the same model choices and effective fast availability.

Successful explicit pairing also includes `external_chat_capabilities` and its
sibling `external_chat_capabilities_generated_at` when the target supplies them.
This consumes the token-delivery snapshot without any additional request and does
not save a capability cache. The snapshot is emitted only after credential
verification. Older targets without these fields still pair successfully. Null,
malformed or unsupported optional data produces null fields, without invalidating
a valid pairing. A pairing snapshot can contain an authorized empty inventory:
`providers: []` and `recommended_selection: null`. Explicit capability discovery
retries inventories with no model choices within the shared budget, then returns
`capabilities_unavailable` with exit code 5 if no choices become available.

The timestamp describes snapshot generation, not an authorization lease. The
existing refresh endpoint does not supply a generation timestamp. Chat requests
still validate current authorization and selection; explicitly refresh if a
selection is no longer available. No chat mutation is automatically replayed by
this command. Pair status retains its single workspace verification and terminal behavior.

## CLI updates

Every command invocation checks `https://registry.npmjs.org/teamclaws` before
command dispatch, including help and version. The check has a 1.5-second total
deadline, a 2 MiB metadata limit, no redirects, no credentials, and no persistent
cache. Registry failure or malformed metadata silently leaves ordinary commands
available. Nothing is installed automatically.

When a newer published stable `latest` release exists, stderr receives:

```text
Version 1.2.0 Available starting on 09/12/2026. Use command teamclaws update to update as soon as possible.
```

With `--json`, stderr receives one newline-delimited `update_available` JSON
object containing `version`, `published_at`, `available_date`, `update_command`,
and `message`. Agents should capture both streams. Existing stdout results,
shell result objects, event streams, help/version text, and command exit codes
retain their contracts. Raw shell stderr follows the advisory unchanged; callers
requiring only remote stderr must separate the first advisory line. Long-running
commands receive the notice once at startup, not on every streamed event.

Run `teamclaws update` (or `teamclaws update --json`) explicitly to install.
The command does not require login. It supports only a verified npm global
installation matching the running package and npm's reported global prefix.
Local, linked, npx, other package-manager installations, mismatched prefixes,
and layouts without npm beside the running Node executable are unsupported;
update those through their original package manager. No prefix is guessed and
no automatic privilege elevation occurs.

The installer uses Node to launch npm's JavaScript entrypoint with literal
arguments on Windows, Linux, and macOS. It pins the official registry, package,
and checked version, disables lifecycle scripts, and verifies the installed
package version afterward. It never accesses the `.teamclaws` credential tree:
login and workspace credentials remain separate from the installed package.
Installation failure returns nonzero; an interrupted npm install may require
repair through npm. The updater does not promise transactional rollback.

Release selection uses `dist-tags.latest`, the matching `versions` manifest,
and `time[version]` in official registry metadata. Prereleases, deprecated
releases, missing publication records, future timestamps, and invalid package
or tarball identity are rejected. The displayed date is the publication date in
UTC, formatted `MM/DD/YYYY`, not the metadata modification date or a private
commit date. Semantic precedence ignores build metadata and never downgrades
an equal/newer candidate; a stable version supersedes its same-core prerelease.
See [npm distribution tags](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/),
[npm publication time fields](https://docs.npmjs.com/cli/v11/commands/npm-view/),
[Semantic Versioning](https://semver.org/), and
[npm installation layouts](https://docs.npmjs.com/cli/v11/configuring-npm/folders/).

## Find conversations started on this computer

Run `teamclaws chat list <target> --json` to recover locally recorded session and
latest request identifiers for a verified pairing. Login and direct pairing
verification are required; listing does not fetch capabilities, create a chat,
send a message, poll a request, or call a remote history endpoint.

The `chat_sessions_list` event has `status: success`, `source: local`, the
selected `workspace`, and `sessions` containing `session_id`, `request_id`,
`owner_conversation_url`, `revision`, `response_cursor`, and `updated_at`.
Use the existing send/watch commands with those identifiers. For watch, pass
revision as `--known-revision` and cursor as `--after-response-message-id`.
Every subsequent remote operation retains its normal authorization checks.

References are saved separately from credentials in private files under
`~/.teamclaws/chat-references/`, partitioned by workspace and paired device.
No message text, tokens, headers, or transcripts are saved. Empty results mean
no locally recorded conversations; other computers' chats and old unsaved
references are not discoverable. Device identity is not included in list output.

If recording fails after a remote response, `chat_reference_recovery` preserves
the validated identifiers and cursors, followed by `chat_reference_storage_failed`
(exit 9). Retain those identifiers and resume with watch; never automatically
repeat the remote mutation. Existing login and pairing credentials are unchanged.
