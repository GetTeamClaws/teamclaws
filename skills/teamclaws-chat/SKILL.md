---
name: teamclaws-chat
description: Start, continue, or resume one external-agent TCChat through the official TeamClaws CLI after this computer is paired with the exact workspace.
---

# TeamClaws external chat

Use the official `teamclaws` executable. The CLI owns credential loading,
authoritative handoff validation, target capability discovery, direct target
transport, idempotency, and durable request polling.

## Required boundary

- Do not read, print, copy, transform, or pass the workspace credential.
- Let the CLI verify the existing TeamClaws account login before chat. Chat
  requests then go directly to the paired workspace using its saved credential.
- Do not download or execute the generated target helper when the installed CLI
  supports these native chat commands.
- Use only an explicit stable server identifier or canonical workspace origin.
- Treat the newline-delimited JSON as an allowlisted protocol. Never expose raw
  HTTP responses or provider-native identifiers.

## Start one conversation

Obtain a non-empty user message, then run:

```text
teamclaws chat start <target> --message <text> --json
```

Use the workspace recommendation by default. Pass `--provider`, `--model`,
`--reasoning`, `--fast`, or `--no-fast` only when the user explicitly requests
an advertised alternative. Preserve `session_id`, `request_id`, `revision`, and
the last assistant `message_id` from safe output.

If `approval_required` appears, present its authenticated
`owner_conversation_url` and continue waiting. Emit each `assistant_message`
once. Claim success only after `request_succeeded` with at least one response.

## Continue or resume

To add a later turn to the same conversation:

```text
teamclaws chat send <target> --session-id <uuid> --message <text> --json
```

To resume monitoring an already-created request without creating anything:

```text
teamclaws chat watch <target> --session-id <uuid> --request-id <uuid> --known-revision <n> --after-response-message-id <n> --json
```

Reuse `--client-request-id <uuid>` after an uncertain create response. Never
invent a new idempotency key to hide uncertainty about whether a turn exists.

## Failure handling

- `login_required` or `invalid_authentication` (exit 3): tell the user to run
  `teamclaws login` and stop; retain the existing workspace pairing.
- `re_pair_required`: direct the user to TCChat Pair & Transfer.
- `selection_unavailable`: use the advertised recommendation unless the user
  asks for another valid selection.
- `rejected`, `expired`, or `canceled`: stop and report the terminal state.
- `failed`: report the safe returned detail and retain the request identifiers.
- network failure: retain identifiers and resume with `chat watch`; do not
  silently create another session or turn.
