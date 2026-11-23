# Project lifecycle commands

Prerequisites: installed matching CLI/server releases, valid account sign-in, verified pairing to the selected workspace, and the user's instruction for the operation. Use a stable workspace ID as `<target>`.

```text
teamclaws projects list <target> --json
teamclaws projects create <target> --path /home/teamclaws_user/example --create-directory --request-id <new-uuid> --json
teamclaws projects rename <target> --project-id 42 --name Example --request-id <new-uuid> --json
teamclaws projects rename <target> --project-id 42 --path /home/teamclaws_user/renamed --request-id <new-uuid> --json
teamclaws projects hide <target> --project-id 42 --request-id <new-uuid> --json
teamclaws projects show <target> --project-id 42 --request-id <new-uuid> --json
teamclaws projects delete <target> --project-id 42 --request-id <new-uuid> --json
```

Concrete read example: `teamclaws projects list 11111111-1111-4111-8111-111111111111 --json` (replace with the actual selected workspace ID).

For every mutation provide a new UUID. Reuse it only with identical arguments after an uncertain response, to retrieve the original server receipt. Never retry an uncertain mutation with a new UUID. A changed payload with an existing UUID is rejected.

Creation registers an existing directory; `--create-directory` explicitly creates one if absent. Only the owner can make new shared host directories under existing policy. Owners/superusers may register an existing allowed directory and rename an allowed project. `--name` changes only the display name; `--path` requests a host-directory rename too. Existing destination directories are never overwritten. Nested registered projects must be handled before a containing directory can move or be removed.

Projects are shared and visible to everyone by default. `hide` and `show` change only the caller's presentation preference; they do not change others' listings, filesystem permissions, or conversation access.

Deletion normally removes only the saved project entry and detaches its chat references. Files, chats, and messages remain. Add `--delete-directory` only with explicit user intent to delete that directory and its contents. Stale entries whose directories are gone can still be removed. Non-owner superusers cannot delete an owner-created project or one whose historical creator provenance is unknown; this is enforced for both deletion variants inside this functionality. Do not attempt to bypass it with another account, shell command, or direct database access.

Require exit code zero and `ok=true`; inspect returned project ID/name/path and directory/record outcome fields. List again for current state: a request retry returns the original receipt, not fresh state. `record_deleted=true` does not mean files were deleted. `directory_exists=true` is expected after record-only removal. Report `partial_failure` and its exact saved/host outcomes accurately and resolve them before claiming completion.

`outcome_unverified` is not success. Retry only the exact request with its original UUID. Missing pairing requires the normal pairing flow; owner-protected, authorization-denied, unsupported-server, and path-collision responses do not authorize credential or database fallbacks. These dedicated operations authenticate through the existing paired target authorization and invoke `/teamclaws-admin/api/projects/`; credentials stay in the CLI's existing storage and request pipeline.
