# Pairing server UUID comparisons removed

Date: 2026-10-24

Owner-requested change: remove the CLI comparisons between the requested server
UUID and the pending response in `src/broker.ts`, and between the pending server
UUID and issued credential in `src/pairing.ts`.

Workspace origin validation, requester/authorization/machine binding checks,
device/pairing identity checks and credential verification remain in place.
The selected broker UUID remains the saved credential's inventory key.

No dependencies or wire fields change. The TypeScript source must be built and
released through the normal npm package path before the installed CLI changes.

Verification: TypeScript typecheck and build passed. In-memory mocked checks
confirmed differing selected/pending/issued server UUIDs are accepted, while
requester mismatch and workspace-origin mismatch remain rejected. git diff
--check passed. No service, migration, cron or static-asset action is required.
The installed CLI is unchanged until normal package release and installation.
