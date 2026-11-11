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

### Find a file the user left on the server

When the user names a file without a path, explain where they probably put it
when working through the CLI, then inspect those locations before asking them
for a full path:

- The directory reported by `pwd`, and the project's directory if known.
- `/tmp/`, especially an existing `/tmp/teamclaws-shared/` handoff directory,
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

For ordinary files, use the shell to create a new staging directory, decode
base64-encoded file bytes there, and compare SHA-256 hashes against the local
files. Construct the argument with a subprocess argument list (no local shell
interpolation). A remote Python example for a single **non-secret** file is:

```text
python3 - <<'TEAMCLAWS_FILE'
import base64, hashlib, pathlib
p = pathlib.Path.home() / 'apps' / 'example-staging' / 'README.md'
p.parent.mkdir(parents=True, exist_ok=True)
with p.open('xb') as output:
    output.write(base64.b64decode('SGVsbG8K', validate=True))
print(hashlib.sha256(p.read_bytes()).hexdigest())
TEAMCLAWS_FILE
```

Replace the path and encoded content from the selected project; the example
writes the bytes `Hello\n`. Exclusive creation prevents overwriting existing
files. Check remote Python availability before using this example. Transfer
larger files in bounded chunks to a new staging file, checking the final hash.
Use project-appropriate consistent exports for databases and persistent data;
copying an active database file is not a verified backup. Preserve file modes
where needed; inspect symlinks and never follow them outside the selected source.
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
