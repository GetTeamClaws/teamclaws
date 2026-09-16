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
npm install -g teamclaws
teamclaws --version
```

To install a downloaded release tarball:

```text
npm install -g ./teamclaws-1.0.1.tgz
teamclaws --version
```

GitHub source ZIPs must be built before use; they are not npm installers.

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

Pairing is broad privileged delegation to the approved workspace. The client
does not request or select scopes, profiles, capability bundles, roles, user
types, or permission labels. TeamClaws, Clawgate, and host policy determine the
authority of the approved credential.

The client never accepts a model or harness access token. An agent that already
discovered a workspace passes only the selected stable server identifier to the
`pair` command.

`pair status` is side-effect free: it reads only the matching protected local
credential, performs at most one direct workspace verification with a
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

## Development

```text
npm ci
npm run verify
```

The package is licensed under the PolyForm Shield License 1.0.0. Paid service
access is enforced by TeamClaws servers, not by the client license.

### Provider and model capabilities

Run `teamclaws chat capabilities <target> [--json]` with an existing saved
workspace pairing. It reads the workspace capabilities endpoint with a shared
120-second budget, attempts lasting at most 15 seconds, and pauses of up to five
seconds between retryable failures or inventories with no model choices. It does not
log in, pair, or start a chat. Without a saved pairing it makes no request.

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
this command. Pair status retains its one-request, terminal behavior.
