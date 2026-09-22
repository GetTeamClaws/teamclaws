---
name: teamclaws-project
description: Move a selected project to a paired TeamClaws machine and optionally run it with the user's public or private access choice. Use after project-transfer or service-setup authorization.
---

# Move and run a project

Use the conversation sequence in [teamclaws-onboard](../teamclaws-onboard/SKILL.md).
Ask for the project if missing and the paired destination if ambiguous. Inspect
its files and instructions before asking for configuration already present.
Preserve the source unless the user explicitly requests deletion. Do not copy
provider credentials, CLI login files, device credentials, or unrelated secrets.
Identify required project secrets separately and use the destination's approved
secret mechanism; do not embed secrets in shell command text or chat.

## Transfer through the existing paired shell

Prerequisites: valid TeamClaws CLI login, verified pairing to the selected stable
server identifier, and user authorization for the selected project/data. Use:

```text
teamclaws shell <server-id> --command <one-quoted-command-argument> --json
```

This sends the exact command over the authenticated workspace HTTPS shell API.
Each command starts in the remote account's home; use explicit working directories.
The result has `stdout`, `stderr`, and `exit_code`. Require exit 0 and independent
destination verification. There is no dedicated CLI file-transfer command and no
implicit SSH connection. Do not invent one or handle the saved credential yourself.

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

For a website, web app, or another service, ask:

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
