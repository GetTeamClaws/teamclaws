# TeamClaws client

The official TeamClaws command-line client pairs a filesystem-capable computer
with a TeamClaws workspace and stores the resulting Clawgate credential on that
computer. The command-line client and its agent skills ship together in this
package.

## Requirements

- Node.js 22 or newer
- Windows 11 or Windows Server 2022 or newer, macOS 14 or newer, or a modern
  GNU/Linux distribution with glibc 2.28 or newer
- x64 or ARM64

## Installation

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

### Onboarding output contract

Existing event names and schema version remain unchanged. The
`login_browser_required` event provides the safe `url`, a `label` of
`Sign in to TeamClaws`, and `account_guidance`. Display these immediately while
login keeps running. Signed-out `auth_status` includes the non-executing
`login_command: "teamclaws login --json"`; status never starts device authorization.

`servers list` requests `GET /api/cli/v1/servers/?include_inventory=1`. Updated
brokers return `servers` and `workspace_count`: the count of all non-deleted
owned and eligible shared workspaces, including those without a hostname yet.
Individual server entries retain aliases, stable IDs, status and `pairing_ready`.
Older brokers may omit the count; the CLI reports it as null and never infers
an empty account from an empty filtered list.

The `servers_list` event adds `workspace_count` and `discovery_state`:
`no_workspaces` only for a verified count of zero, `ready` when any listed
workspace is pairing-ready, `not_ready` when workspaces exist but none is ready,
and `unknown` for an empty legacy response without a count. Discovery errors
remain error events. A verified empty account uses https://teamclaws.com/app/ to
purchase a workspace. Existing owners whose machines are being prepared do not
need another purchase. Targetless pairing requires explicit selection even for
one result; agents present aliases and pass only user-selected stable IDs.

## Commands

```text
npx teamclaws login
npx teamclaws login <email>
npx teamclaws auth status
npx teamclaws logout
npx teamclaws servers list
npx teamclaws pair status <server-identifier-or-canonical-workspace-address>
npx teamclaws pair
npx teamclaws pair <server-identifier-or-canonical-workspace-address> [--no-open]
npx teamclaws shell <target> --command <text> [--json]
npx teamclaws chat start <target> --message <text>
npx teamclaws chat send <target> --session-id <uuid> --message <text>
npx teamclaws chat watch <target> --session-id <uuid> --request-id <uuid>
```

Human-readable output is the default. Add `--json` for the strict, versioned,
newline-delimited JSON event stream intended for automation.

Pairing (including explicit targets), server listing, pair status, chat, and shell
require a valid TeamClaws CLI account login. Run `teamclaws login` first. The CLI
refreshes and verifies that login before contacting the workspace or requesting
pairing approval. Missing or invalid authentication exits with code 3 in both
human and JSON modes. Help, version, login, auth status, and logout remain
available. Saved workspace credentials are preserved when login is required.

Pairing is broad privileged delegation to the approved workspace. The client
does not request or select scopes, profiles, capability bundles, roles, user
types, or permission labels. TeamClaws, Clawgate, and host policy determine the
authority of the approved credential.

The client never accepts a model or harness access token. An agent that already
discovered a workspace passes only the selected stable server identifier to the
`pair` command.

After account authentication, `pair status` reads the matching protected local
workspace credential, performs at most one direct workspace verification with a
five-second timeout, reports the result, and stops. It never starts pairing or
loads external-chat resources.

After pairing, `chat start`, `chat send`, and `chat watch` use the protected
workspace credential directly against that exact workspace. They verify the
authoritative versioned handoff, resolve the workspace capability catalog, and
stream only allowlisted durable request events. They never send the workspace
credential through `www.teamclaws.com` or download and execute the generated
Python helper. Use `--client-request-id <uuid>` to safely repeat an uncertain
create request, and use the watch cursors printed in JSON events to resume
monitoring without creating another turn.

## Host shell commands

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

Login credentials are stored in the private TeamClaws user directory. Completed
workspace credentials are stored by stable server identifier beneath
`~/.teamclaws/clawgate-devices/<server-uuid>.json`. Writes are atomic. Unix
directories use mode `0700` and files use mode `0600`; Windows uses
inheritance-disabled access-control entries limited to the current user and the
Windows system account.

The package is licensed under the PolyForm Shield License 1.0.0. Paid service
access is enforced by TeamClaws servers, not by the client license.

### Provider and model capabilities

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
