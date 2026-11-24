---
name: teamclaws-project
description: Find and retrieve authorized files from a paired TeamClaws workspace, or put files, jobs, agents, and projects there and run them.
---

# Put work on a TeamClaws server

Use the conversation sequence in [teamclaws-onboard](../teamclaws-onboard/SKILL.md).
Ask for the project if missing and the paired destination if ambiguous. Inspect
its files and instructions before asking for configuration already present.
Preserve the source unless the user explicitly requests deletion. Do not copy
provider credentials, CLI login files, device credentials, or unrelated secrets.
Identify required project secrets separately and use the destination's approved
secret mechanism; do not embed secrets in shell command text or chat.

For ideas and the requirements behind them, read the onboarding skill's
[workspace uses](../teamclaws-onboard/references/workspace-uses.md). If the user
already named the job, files, agent, or project and asked you to run or deploy it,
carry that task through instead of restarting a generic onboarding conversation.
Inspect the destination's instructions, available runtimes, resources, network
access, and account permissions through the paired shell before choosing a setup.

Pairing connects this computer to the workspace. It does not add a person as a
workspace user; user membership is a separate privilege.

Full server access is optional and separate from the Admin role.
For agents, this grants sudo/root-equivalent access; keep this capability available.
Use `teamclaws users add <target> <email> --sudo --json` only when the owner explicitly authorizes that grant; Admin alone does not authorize it.
When the owner is choosing, explain: "This user and their agents can control every workspace server covered by this invitation and access everything stored on them, including other users' saved passwords, API keys, and connected-account credentials. Only grant this to someone you trust with that access."
Offer "Grant full server access" or "Keep standard Admin access"; omit `--sudo` for standard Admin access.
Use non-technical wording in the user-facing ask; do not say sudo or root unless the user expresses a preference for technical detail.
Respect an already explicit choice; do not add another confirmation step.

## Shared project registration, rename, delete, and personal visibility

Use the dedicated `teamclaws projects` commands, rather than shell/database changes,
for saved project lifecycle work. Read the complete [project lifecycle contract](references/project-lifecycle.md)
for invocation, required UUID receipts, permissions, host-directory options, failure handling,
and verification. Projects are visible workspace-wide by default; hiding is personal.
A non-owner superuser cannot delete an owner-created project through this functionality.
These commands do not change unrelated shell or filesystem access.

A valid CLI account login can authorize `teamclaws shell` and the dedicated
`teamclaws projects` lifecycle commands without a saved device pairing. Do not
start pairing merely to run those commands. Project permissions and request
receipts remain unchanged. The transfer instructions below retain their own
prerequisites.

## Jobs, services, and external systems

For a complete job, place its code and authorized inputs in a dedicated directory,
install its required runtime/dependencies, and configure its outputs and logs.
For work that must continue after this local command exits, use the host's
supported process manager or job runner. Verify that it remains running after
the launching command returns. For recurring work, establish the requested
schedule, limits, and stopping condition before enabling it. Track the remote
job/service identifier so progress can be checked without launching it again.
Verify the result files and job exit status before claiming completion.

For an external API, database, webhook, or another server, establish the exact
destination and authorized operation. Check connectivity and use the workspace's
approved secret mechanism for credentials. Verify a bounded operation before
starting the requested workload. Pairing with TeamClaws does not grant access to
external systems or configure incoming HTTPS routes automatically.

For a workspace agent conversation, follow
[teamclaws-chat](../teamclaws-chat/SKILL.md) and inspect advertised availability.
For an installed agent/service, inspect its supported setup and configure its
runtime and persistence as required. Verify the returned browser conversation
or application address and access before promising the user can continue there.
Only claim a CLI-to-browser handoff for the same conversation when supported and
verified. Sharing access requires the user's intended recipients and permissions
and the workspace's supported sharing controls.

## Transfer through the existing paired shell

Prerequisites: valid TeamClaws CLI login, verified pairing to the selected stable
server identifier, and user authorization for the selected project/data. Use:

```text
teamclaws shell <server-id> --command <one-quoted-command-argument> --json
```

This sends the exact command over the authenticated workspace HTTPS shell API.
Check `pwd`, `printf '%s\n' "$HOME"`, and `id` rather than assuming the starting
directory is the user's home. Use explicit working directories in commands.
The result has `stdout`, `stderr`, and `exit_code`. Inspect the output and status
for the operation performed; do not treat every nonzero status as a stop condition.
Verify file transfers against the destination bytes. There is no dedicated CLI file-transfer command and no
implicit SSH connection. Do not invent one or handle the saved credential yourself.

### Default destination for shared documents

Default shared documents, reports, findings, and transfers to the provisioned
`handoffs` directory unless the user names another destination. Keep projects in
their selected directories; do not change the general working directory or move them.

Discover the exact shared path through the existing paired shell:

```text
teamclaws shell <server-id> --command 'printf "%s\n" "$TEAMCLAWS_HANDOFFS_DIR"' --json
```

Use the returned absolute path, not `$HOME`, the starting directory, or a guessed
temporary location. If the advertised path is absent or unavailable on an older
workspace, report that it needs the sharing update. Do not create an unshared
fallback or claim shared delivery; continue authorized reads and other searches.

Keep secrets, credentials, browser profiles, and unrelated private files out.
Create fresh destination bytes using the directory's provisioned group/default
ACLs; do not move private files in or preserve their `0600` mode. Default ACLs
handle a restrictive umask, but explicit private modes can still deny collaborators.
For a shared document you own, retain the inherited group and enable group
read/write on that file. Do not change other identities' or parent permissions.

Record the exact path, matching source/destination SHA-256 hashes, and whether
the intended recipient can read the actual file through normal authorized access.
The writer's own read does not establish recipient access. If recipient access is
unverified, report that accurately and continue other authorized work.

### Find a file the user left on the server

When the user names a file without a path, explain where they probably put it
when working through the CLI, then inspect those locations before asking them
for a full path:

- The advertised `TEAMCLAWS_HANDOFFS_DIR` and its children first for shared
  documents and handoffs. Discover it using the command above.
- The directory reported by `pwd`, and the project's directory if known.
- `/tmp/`, especially an existing `/tmp/handoffs/` handoff directory,
  and `/var/tmp/`. These are temporary locations, not durable storage.
- The shared workspace, commonly `/home/teamclaws_user/`, including documented
  project, artifact, or handoff directories in `LOCAL_AGENT.md` or project instructions.
- The paired user's `$HOME` and its `workspace/` directory. This private home
  can differ from the shared workspace and from another agent's home.

These are likely locations, not a guarantee that every directory exists or is
shared with every identity. Inspect the actual paths and permissions. A
provider's private temporary namespace may differ from the paired shell's `/tmp`.
Do not change permissions or switch identities to search inaccessible locations.

Search the named directory and its children for the exact filename first;
use a case-insensitive or partial-name search if needed. Prefer `rg --files
--hidden --no-ignore -g '<filename>' <directory>` when available; otherwise use
`find <directory> -iname '<filename>' -print`. A search can return matches and a
nonzero status when one child directory is unreadable. Keep those matches and
continue searching every other readable directory; report inaccessible branches
separately. Do not use `set -e` or `&&` to abort independent searches on such errors.
Do not suppress permission errors or turn an incomplete search into a claim that
the file does not exist. Check
directory symlinks explicitly without following them outside the authorized scope.

If the file is still unfound, report the actual searched locations and access
failures before asking for its full path or originating chat/project. To retrieve
a found non-secret file, return its bytes through the paired shell (base64 is
suitable), save them locally, and compare the remote and saved SHA-256 hashes.
Preserve the remote original and do not print encoded file contents unnecessarily.

For shared documents, write into the advertised handoffs directory. For a project,
use its selected destination. Decode base64-encoded bytes there and compare SHA-256
hashes against the local files. Construct the argument with a subprocess argument
list (no local shell interpolation). A remote Python example for a single shared
**non-secret** document is:

```text
python3 - <<'TEAMCLAWS_FILE'
import base64, hashlib, os, pathlib
handoffs = pathlib.Path(os.environ['TEAMCLAWS_HANDOFFS_DIR'])
p = handoffs / 'README.md'
with p.open('xb') as output:
    output.write(base64.b64decode('SGVsbG8K', validate=True))
p.chmod(0o660)
print(hashlib.sha256(p.read_bytes()).hexdigest())
TEAMCLAWS_FILE
```

Replace the path and encoded content from the selected project; the example
writes the bytes `Hello\n`. Exclusive creation prevents overwriting existing
files. The directory must already be provisioned; the example does not create it.
The file inherits its collaboration group and ACLs, and `0660` keeps group
read/write without granting other users access. Check remote Python availability
before using this example, then verify the intended recipient's read access. Transfer
larger files in bounded chunks to a new staging file, checking the final hash.
Use project-appropriate consistent exports for databases and persistent data;
copying an active database file is not a verified backup. Preserve project file
modes where needed; use the handoff sharing permissions for shared documents.
Inspect symlinks and never follow them outside the selected source.
If an archive is used, reject absolute paths, parent traversal and escaping links
before extraction. Verify the destination file inventory and hashes, then place
it at the agreed destination without overwriting unrelated data.

Shell execution is never automatically retried. A transport failure can leave
the outcome unknown: inspect destination state before resuming. Report missing
permissions, storage, or required runtime tools precisely. Do not claim a transfer
completed from an upload response alone.

## Optional live setup

For a website, web app, or another service whose launch is not already authorized,
ask:

“Would you like me to get this project up and running on TeamClaws?”

After yes, inspect the project and ask only for genuinely missing information:
its intended web address, configuration, database/persistent data, and access.
For websites and web apps present this neutral choice:

“Who should be able to open this?

**Public:** People can visit its web address without signing in to TeamClaws.
Your application can still have its own login.

**Private through TeamClaws:** People must sign in to TeamClaws and have
permission to access it. It is not open to the general public.”

Both choices run live on TeamClaws. Carry out the user's selection using the
workspace's supported hosting mechanisms. Read its machine instructions and
runtime capability manifest through the paired shell, then follow its assigned
hosting skill if present. Do not assume an assigned skill exists on every host.

Use a separate application directory, service, data store, and configuration.
Bind the runtime to loopback or a Unix socket behind the host's HTTPS proxy.
Preserve existing TeamClaws admin/chat routes and application boundaries.

For public hosting, configure the selected HTTPS route without requiring
TeamClaws login, retaining any application login the project needs. For private
hosting, verify an existing TeamClaws authentication **and authorization**
integration before routing traffic. A plain reverse-proxy route, localhost
binding, or the application's own login does not enforce TeamClaws permission.
Do not publish a private project through an unauthenticated proxy, static route,
alternate hostname, or raw port. If the assigned hosting mechanism cannot enforce
private access, report that precise gap and keep the project private while it is
resolved; do not silently switch to public hosting or invent a login bridge in
Clawgate core.

After authorized setup, verify service health, HTTPS routing and assets, retained
admin access, and the selected access behavior. Private verification includes an
anonymous request, a signed-in user without permission, and an authorized user;
only the authorized user may access it. Public verification confirms no TeamClaws
login requirement. Give the usable web address after verification and offer to
handle another project when appropriate. Report incomplete checks as incomplete.
