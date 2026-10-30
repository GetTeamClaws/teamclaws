---
name: teamclaws-chat
description: Read workspace chat history or start, continue, and resume an external-agent TCChat through the official TeamClaws CLI after this computer is paired with the exact workspace.
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

## Read chats and follow-up messages without a browser

For conversation history, new messages, or follow-ups, use these read-only commands:

```text
teamclaws chat history <target> --json
teamclaws chat messages <target> --chat-id <chat-public-uuid> --json
teamclaws chat messages <target> --chat-id <chat-public-uuid> --after-message-id <last-read-id> --json
```

`chat history` queries the workspace and emits `chat_history` pages containing
`chats`, including browser-created, archived, empty, and deleted chats. Use the
returned `chat_id`, or the `chat_public_id` in the user's conversation URL, with
`chat messages`. It emits `chat_messages` pages containing every returned role
and message body, including owner follow-ups and subsequent agent replies.
Both commands fetch every page automatically. Save the final
`latest_message_id` to check for later messages. A successful empty messages
result means no messages after that cursor in that chat at the time of the read.

History access is standard for existing and new valid pairings. There is no
optional history permission, browser approval, model selection, or new pairing
step. The workspace owner's paired agents can read every user's chats on that
workspace. Other paired agents, including superusers' agents, can read every
chat belonging to their own user. The workspace enforces this distinction.

`chat list` is a local request-reference index, not a workspace chat inventory.
`chat watch` reads replies to one request, not later conversation turns. Do not
use either as evidence that a conversation has no follow-ups. Never send a
message, start another chat, or use the browser just to read history. An HTTP
error or incomplete pagination is not evidence of an empty history.

On `no_provider_paired`, explain that no AI provider is paired for this workspace.
Open the verified workspace's `/teamclaws-admin/` page and choose **Link AI
Account**. For Cursor, choose **Cursor**, then **My Subscription**, and complete
browser authorization. Do not describe an unavailable inventory or a transport
failure as proof that no provider is paired.

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

## Connected-app task approval

When the connected workspace agent explicitly reports that a task involving an
app connected through the TeamClaws API (such as email or calendar) is waiting
for the user's external approval, direct the user to
[TeamClaws Activity](https://www.teamclaws.com/activity/) to review the pending
request. Do not infer Activity approval from a generic pending state.

This is connected-app task approval. CLI login and workspace pairing retain
their existing approval links; TCChat `approval_required` retains its returned
`owner_conversation_url`. Never automatically approve a request or resubmit the
task because approval is pending. Retain the existing request identifiers and
follow the task's existing monitoring/resume instructions, using `chat watch`
when resuming an already-created chat request.

## Find locally recorded conversations

If session/request identifiers were lost, first run:

```text
teamclaws chat list <target> --json
```

This verifies login and the selected pairing, then emits `chat_sessions_list`
with `source: local` and `sessions`. Records include `session_id`, latest saved
`request_id`, `owner_conversation_url`, `revision`, and `response_cursor`.
Use revision as `--known-revision` and cursor as `--after-response-message-id`
when resuming watch. Select the intended conversation before sending a new turn.

Only conversations recorded on this computer for the current paired device are
listed. Empty results mean no locally recorded conversations, not no workspace
conversations. Older unsaved IDs and chats created on other machines are not
imported. The index stores references, never messages or credentials. It is not
proof of authorization: send/watch still perform their normal checks. Do not
create another chat or re-pair merely because the list is empty.

On `chat_reference_storage_failed`, preserve identifiers from the
`chat_reference_recovery` event (or its human-readable equivalent). A remote
request may already have succeeded. Do not automatically resend it; use the
returned identifiers with the existing watch command after resolving storage.

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
