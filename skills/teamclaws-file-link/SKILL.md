---
name: teamclaws-file-link
description: Give the user an authenticated browser link to review an existing file on a TeamClaws workspace, including a handoff or report, without starting an agent.
---

# Link to a workspace file

Run the bundled CLI command:

```text
teamclaws files link <workspace-id-or-url> --path <file> --json
```

Use the workspace and file the user selected. Relative paths are relative to
`/home/teamclaws_user`, the production viewer's shared workspace root, not the
shell user's home. Absolute paths within that root are also accepted.

The command resolves the workspace through the signed-in account, verifies
that the file exists and is readable through the existing shell access, and
returns an encoded `url`. It works with existing account shell access without
requiring device pairing. Do not start a pairing flow just to make a link.

Display the returned `url` unchanged as a Markdown link with a readable label.
Do not assemble query parameters yourself, create a chat, send a message, or
launch an agent. The link opens the existing new-chat Files viewer when the
user clicks it; generating it does not create a chat record.

The link requires browser sign-in and the viewer's existing authorization.
Filesystem readability is not proof of viewer access or successful rendering.
Claim a working preview only after observing it. On an error, report the exact
failure; do not offer a guessed URL, public copy, administrator identity, or
credential-sharing workaround. Do not link secrets or credentials.
