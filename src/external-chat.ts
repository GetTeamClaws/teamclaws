import { randomUUID } from "node:crypto";

import { PACKAGE_VERSION } from "./constants.js";
import { TeamClawsError } from "./errors.js";
import {
  errorFromResponse,
  type FetchLike,
  type JsonRequestOptions,
  type JsonResponse,
} from "./http.js";
import type { Output } from "./output.js";
import type { CredentialStore } from "./storage.js";
import {
  TargetAuthorization,
  requestTargetJson,
} from "./target-authorization.js";
import type {
  CapabilityInventory,
  ChatHistoryEntry,
  ChatHistoryMessage,
  ExternalChatHandoff,
  PairingTarget,
  StatusWorkspaceCredential,
} from "./types.js";
import {
  isObject,
  normalizeUuid,
  parseVerifiedWorkspace,
  parseVerifiedDevice,
  requireHttpsUrl,
  requireInteger,
  requireString,
} from "./validation.js";

const REQUIRED_SCOPES = new Set([
  "external_chat:capabilities:read",
  "external_chat:sessions:create",
  "external_chat:sessions:write",
]);
const PENDING_STATUSES = new Set([
  "received",
  "awaiting_approval",
  "approved",
  "queued",
  "running",
]);
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "rejected",
  "failed",
  "expired",
  "canceled",
]);

export type ChatSelection = {
  provider_key: string;
  model_name: string;
  reasoning_effort: string;
  fast_mode: boolean;
};

export type ChatStartOptions = {
  target: PairingTarget;
  message: string;
  provider?: string;
  model?: string;
  reasoning?: string;
  fastMode?: boolean;
  clientRequestId?: string;
};

export type ChatSendOptions = {
  target: PairingTarget;
  sessionId: string;
  message: string;
  clientRequestId?: string;
};

export type ChatWatchOptions = {
  target: PairingTarget;
  sessionId: string;
  requestId: string;
  knownRevision: number;
  responseCursor: number;
};

type CapabilityModel = {
  id: string;
  reasoning: Set<string>;
  fast: boolean;
};

type CapabilityProvider = {
  id: string;
  models: CapabilityModel[];
};

type Capabilities = {
  providers: CapabilityProvider[];
  recommended: ChatSelection | null;
  pollSeconds: number;
  messageChars: number;
  allowFast: boolean;
};

type ExternalChatContext = {
  credential: StatusWorkspaceCredential;
  capabilities: Capabilities;
};

type RequestState = {
  requestId: string;
  sessionId: string;
  status: string;
  revision: number;
  responseCursor: number;
  ownerUrl: string;
  messages: Array<{
    id: number;
    body: string;
    provider: string;
    model: string;
  }>;
  errorCode: string;
  errorDetail: string;
};

export type ExternalChatClientOptions = {
  fetcher?: FetchLike;
  now?: () => number;
  store: CredentialStore;
  output: Output;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  authorization?: TargetAuthorization;
};

export class ExternalChatClient {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly store: CredentialStore;
  private readonly output: Output;
  private readonly authorization: TargetAuthorization;
  private readonly wait: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;

  constructor(options: ExternalChatClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => performance.now());
    this.store = options.store;
    this.output = options.output;
    this.authorization =
      options.authorization ??
      new TargetAuthorization(this.store, this.fetcher);
    this.wait = options.wait ?? waitFor;
  }

  async capabilities(
    target: PairingTarget,
    signal?: AbortSignal,
  ): Promise<number> {
    const result = await this.listInventory(target, signal);
    this.output.capabilityInventory(
      result.workspace,
      result.external_chat_capabilities,
    );
    return 0;
  }

  async listInventory(
    target: PairingTarget,
    signal?: AbortSignal,
    resolvedCredential?: StatusWorkspaceCredential,
  ): Promise<{
    workspace: { server_id: string; origin: string };
    external_chat_capabilities: CapabilityInventory;
  }> {
    const deadline = this.now() + 120_000;
    const canceled = (): void => {
      if (signal?.aborted) {
        throw new TeamClawsError("cancelled", "The operation was cancelled.");
      }
    };
    canceled();
    const credential =
      resolvedCredential ?? (await this.store.findWorkspace(target));
    if (!credential) {
      throw new TeamClawsError(
        "re_pair_required",
        "No saved pairing was found for this workspace. Pair it first.",
        { exitCode: 3 },
      );
    }
    let lastFailure = "No provider/model inventory was available.";
    while (this.now() < deadline) {
      canceled();
      const remainingAttempt = deadline - this.now();
      if (remainingAttempt < 1) break;
      const timeoutMs = Math.max(
        1,
        Math.floor(Math.min(60_000, remainingAttempt)),
      );
      const timeout = AbortSignal.timeout(timeoutMs);
      const attemptSignal = signal
        ? AbortSignal.any([timeout, signal])
        : timeout;
      try {
        const url = `${credential.origin}/teamclaws-admin/api/device-chat/v1/capabilities/`;
        const response = await requestTargetJson(
          this.fetcher,
          this.authorization,
          url,
          credential,
          {
            headers: {
              "User-Agent": `TeamClaws-CLI/${PACKAGE_VERSION}`,
            },
            timeoutMs,
            signal: attemptSignal,
          },
        );
        canceled();
        if (response.status !== 200) {
          const denied = response.status === 401 || response.status === 403;
          throw new TeamClawsError(
            denied ? "capabilities_denied" : "capabilities_unavailable",
            denied
              ? "The workspace rejected capability access. Check the pairing."
              : `The workspace could not provide capabilities (HTTP ${response.status}).`,
            {
              exitCode: denied ? 3 : 5,
              retryable: [408, 429, 500, 502, 503, 504].includes(
                response.status,
              ),
            },
          );
        }
        const inventory = parseCapabilityInventory(response.body);
        if (this.now() >= deadline) break;
        if (
          inventory.providers.some((provider) => provider.models.length > 0)
        ) {
          return {
            workspace: {
              server_id: credential.server_id,
              origin: credential.origin,
            },
            external_chat_capabilities: inventory,
          };
        }
        lastFailure = "The workspace returned no provider/model choices.";
      } catch (error) {
        canceled();
        // Body reads occur outside requestJson's fetch catch; classify their
        // timeout here without changing send/watch transport behavior.
        if (timeout.aborted) {
          lastFailure = "The inventory request timed out.";
        } else if (error instanceof TeamClawsError && error.retryable) {
          lastFailure = error.message;
        } else {
          throw error;
        }
      }
      canceled();
      const remaining = deadline - this.now();
      if (remaining > 0) await this.wait(Math.min(5_000, remaining), signal);
    }
    canceled();
    throw new TeamClawsError(
      "capabilities_unavailable",
      `${lastFailure} Log into TeamClaws and ensure the server is running.`,
      { exitCode: 5, retryable: true },
    );
  }

  async start(
    options: ChatStartOptions,
    signal?: AbortSignal,
  ): Promise<number> {
    const context = await this.context(options.target, signal, true);
    const selection = resolveStartSelection(context.capabilities, options);
    const message = validateMessage(options.message, context.capabilities);
    this.output.chatCapabilities(selection);
    const clientRequestId = validUuid(options.clientRequestId ?? randomUUID());
    const response = await this.request(
      `${context.credential.origin}/teamclaws-admin/api/device-chat/v1/sessions/`,
      context.credential,
      {
        method: "POST",
        body: {
          client_request_id: clientRequestId,
          provider_key: selection.provider_key,
          model_name: selection.model_name,
          reasoning_effort: selection.reasoning_effort,
          fast_mode: selection.fast_mode,
          initial_message: message,
        },
      },
      [200, 201],
      signal,
    );
    if (!isObject(response.body) || !isObject(response.body.session)) {
      throw invalidChatResponse();
    }
    const sessionId = validUuid(response.body.session.session_id);
    const initial = parseRequest(
      response.body.initial_message_request,
      context.credential.origin,
      response.body.session.owner_conversation_url,
    );
    if (initial.sessionId !== sessionId) throw invalidChatResponse();
    this.output.chatSessionCreated(
      sessionId,
      initial.requestId,
      initial.status,
      initial.ownerUrl,
    );
    return this.poll(context, initial, 0, 0, signal);
  }

  async send(options: ChatSendOptions, signal?: AbortSignal): Promise<number> {
    const context = await this.context(options.target, signal);
    const sessionId = validUuid(options.sessionId);
    const message = validateMessage(options.message, context.capabilities);
    const clientRequestId = validUuid(options.clientRequestId ?? randomUUID());
    const response = await this.request(
      `${context.credential.origin}/teamclaws-admin/api/device-chat/v1/sessions/${sessionId}/messages/create/`,
      context.credential,
      {
        method: "POST",
        body: { client_request_id: clientRequestId, body_text: message },
      },
      [200, 202],
      signal,
    );
    if (!isObject(response.body)) throw invalidChatResponse();
    const request = parseRequest(
      response.body.request,
      context.credential.origin,
    );
    if (request.sessionId !== sessionId) throw invalidChatResponse();
    return this.poll(context, request, 0, 0, signal);
  }

  async watch(
    options: ChatWatchOptions,
    signal?: AbortSignal,
  ): Promise<number> {
    const context = await this.context(options.target, signal);
    const sessionId = validUuid(options.sessionId);
    const requestId = validUuid(options.requestId);
    return this.poll(
      context,
      { requestId, sessionId },
      options.knownRevision,
      options.responseCursor,
      signal,
    );
  }

  private async historyCredential(
    target: PairingTarget,
    signal?: AbortSignal,
  ): Promise<StatusWorkspaceCredential> {
    const credential = await this.store.findWorkspace(target);
    if (!credential)
      throw new TeamClawsError(
        "re_pair_required",
        "No saved pairing was found for this workspace. Pair it first.",
        { exitCode: 3 },
      );
    const response = await this.request(
      `${credential.origin}/teamclaws-admin/api/device-pairings/me/`,
      credential,
      {},
      [200],
      signal,
    );
    parseVerifiedDevice(response.body, credential.device_id);
    return credential;
  }

  async history(target: PairingTarget, signal?: AbortSignal): Promise<number> {
    const credential = await this.historyCredential(target, signal);
    let afterId = 0;
    while (true) {
      const response = await this.request(
        `${credential.origin}/teamclaws-admin/api/device-chat/v1/chats/?after_id=${afterId}`,
        credential,
        {},
        [200],
        signal,
      );
      const body = response.body;
      if (!isObject(body) || !Array.isArray(body.chats))
        throw invalidChatResponse();
      const chats: ChatHistoryEntry[] = body.chats.map((chat: unknown) => {
        if (!isObject(chat)) throw invalidChatResponse();
        const url = requireHttpsUrl(
          chat.owner_conversation_url,
          "conversation address",
        );
        if (url.origin !== credential.origin) throw invalidChatResponse();
        return {
          chat_id: validUuid(chat.chat_id),
          name: historyText(chat.name),
          surface: historyText(chat.surface),
          created_at: historyText(chat.created_at),
          updated_at: historyText(chat.updated_at),
          archived_at:
            chat.archived_at === null ? null : historyText(chat.archived_at),
          deleted_at:
            chat.deleted_at === null ? null : historyText(chat.deleted_at),
          owner_conversation_url: url.toString(),
        };
      });
      const next =
        body.next_after_id === null
          ? null
          : requireInteger(
              body.next_after_id,
              "history cursor",
              afterId + 1,
              Number.MAX_SAFE_INTEGER,
            );
      if (next !== null && chats.length === 0) throw invalidChatResponse();
      this.output.chatHistory(chats, next);
      if (next === null) return 0;
      afterId = next;
    }
  }

  async messages(
    target: PairingTarget,
    chatId: string,
    afterId: number,
    signal?: AbortSignal,
  ): Promise<number> {
    chatId = validUuid(chatId);
    const credential = await this.historyCredential(target, signal);
    while (true) {
      const response = await this.request(
        `${credential.origin}/teamclaws-admin/api/device-chat/v1/chats/${chatId}/messages/?after_id=${afterId}`,
        credential,
        {},
        [200],
        signal,
      );
      const body = response.body;
      if (
        !isObject(body) ||
        body.chat_id !== chatId ||
        !Array.isArray(body.messages) ||
        typeof body.has_more !== "boolean"
      )
        throw invalidChatResponse();
      let previousId = afterId;
      const messages: ChatHistoryMessage[] = body.messages.map(
        (message: unknown) => {
          if (!isObject(message)) throw invalidChatResponse();
          const id = requireInteger(
            message.id,
            "message identifier",
            previousId + 1,
            Number.MAX_SAFE_INTEGER,
          );
          previousId = id;
          return {
            id,
            role: historyText(message.role),
            body_text: historyText(message.body_text),
            status: historyText(message.status),
            created_at: historyText(message.created_at),
          };
        },
      );
      const latest = requireInteger(
        body.latest_message_id,
        "message cursor",
        afterId,
        Number.MAX_SAFE_INTEGER,
      );
      if (latest !== previousId || (body.has_more && messages.length === 0))
        throw invalidChatResponse();
      this.output.chatMessages(chatId, messages, latest, body.has_more);
      if (!body.has_more) return 0;
      afterId = latest;
    }
  }

  async list(target: PairingTarget, signal?: AbortSignal): Promise<number> {
    const credential = await this.store.findWorkspace(target);
    if (!credential)
      throw new TeamClawsError(
        "re_pair_required",
        "No saved pairing was found for this workspace. Pair it first.",
        { exitCode: 3 },
      );
    const response = await this.request(
      `${credential.origin}/teamclaws-admin/api/device-pairings/me/`,
      credential,
      {},
      [200],
      signal,
    );
    parseVerifiedDevice(response.body, credential.device_id);
    requirePairingScopes(response.body);
    this.output.chatSessionsList(
      credential,
      await this.store.listConversations(credential),
    );
    return 0;
  }

  private async record(
    context: ExternalChatContext,
    state: RequestState,
    responseCursor: number,
  ): Promise<void> {
    try {
      await this.store.upsertConversation(context.credential, {
        server_id: context.credential.server_id,
        origin: context.credential.origin,
        device_id: context.credential.device_id,
        session_id: state.sessionId,
        request_id: state.requestId,
        owner_conversation_url: state.ownerUrl,
        revision: state.revision,
        response_cursor: responseCursor,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      // The remote operation already happened. Preserve its safe references even
      // if local storage is unavailable; never replay the mutation.
      this.output.chatReferenceRecovery(
        state.sessionId,
        state.requestId,
        state.ownerUrl,
        state.revision,
        responseCursor,
      );
      throw error;
    }
  }

  private async context(
    target: PairingTarget,
    signal?: AbortSignal,
    starting = false,
  ): Promise<ExternalChatContext> {
    const credential = await this.store.findWorkspace(target);
    if (!credential) {
      throw new TeamClawsError(
        "re_pair_required",
        "No saved pairing was found for this workspace. Pair it first.",
        { exitCode: 3 },
      );
    }
    const verifiedResponse = await this.request(
      `${credential.origin}/teamclaws-admin/api/device-pairings/me/`,
      credential,
      {},
      [200],
      signal,
    );
    const verified = parseVerifiedWorkspace(
      verifiedResponse.body,
      credential.device_id,
      credential.origin,
    );
    requirePairingScopes(verifiedResponse.body);
    const handoff = requireReadyHandoff(verified.external_chat_handoff);
    if (starting) {
      const result = await this.listInventory(target, signal, credential);
      return {
        credential,
        capabilities: parseCapabilities(
          result.external_chat_capabilities,
          true,
        ),
      };
    }
    const capabilityResponse = await this.request(
      new URL(handoff.capabilities_url, `${credential.origin}/`).toString(),
      credential,
      {},
      [200],
      signal,
    );
    return {
      credential,
      capabilities: parseCapabilities(capabilityResponse.body),
    };
  }

  private async poll(
    context: ExternalChatContext,
    current: RequestState | { requestId: string; sessionId: string },
    knownRevision: number,
    responseCursor: number,
    signal?: AbortSignal,
  ): Promise<number> {
    let state = "status" in current ? current : undefined;
    let lastStatus = "";
    let approvalReported = false;
    let initialResume = knownRevision > 0;
    const seenMessageIds = new Set<number>();
    if (responseCursor > 0) seenMessageIds.add(responseCursor);
    while (true) {
      if (!state) {
        const query = new URLSearchParams({
          known_revision: String(knownRevision),
          after_response_message_id: String(responseCursor),
        });
        const response = await this.request(
          `${context.credential.origin}/teamclaws-admin/api/device-chat/v1/requests/${current.requestId}/?${query.toString()}`,
          context.credential,
          {},
          [200],
          signal,
        );
        if (!isObject(response.body)) throw invalidChatResponse();
        state = parseRequest(response.body.request, context.credential.origin);
      }
      if (
        state.requestId !== current.requestId ||
        state.sessionId !== current.sessionId ||
        state.revision < Math.max(1, knownRevision) ||
        state.responseCursor < responseCursor
      ) {
        throw invalidChatResponse();
      }
      if (initialResume && state.revision === knownRevision) {
        lastStatus = state.status;
        approvalReported = state.status === "awaiting_approval";
      }
      initialResume = false;
      if (state.status !== lastStatus) {
        this.output.chatRequestStatus(
          state.sessionId,
          state.requestId,
          state.status,
          state.revision,
        );
        lastStatus = state.status;
      }
      if (state.status === "awaiting_approval" && !approvalReported) {
        this.output.chatApprovalRequired(
          state.sessionId,
          state.requestId,
          state.ownerUrl,
        );
        approvalReported = true;
      }
      for (const message of state.messages) {
        if (seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);
        this.output.chatAssistantMessage(
          state.sessionId,
          state.requestId,
          message.id,
          message.body,
          message.provider,
          message.model,
        );
      }
      knownRevision = state.revision;
      responseCursor = Math.max(
        responseCursor,
        state.responseCursor,
        ...seenMessageIds,
      );
      await this.record(context, state, responseCursor);
      if (TERMINAL_STATUSES.has(state.status)) break;
      if (!PENDING_STATUSES.has(state.status)) throw invalidChatResponse();
      state = undefined;
      await this.wait(context.capabilities.pollSeconds * 1_000, signal);
    }
    if (
      state.status === "succeeded" &&
      state.ownerUrl &&
      seenMessageIds.size > 0
    ) {
      this.output.chatRequestSucceeded(
        state.sessionId,
        state.requestId,
        seenMessageIds.size,
        state.ownerUrl,
      );
      return 0;
    }
    const code = state.errorCode || "response_missing";
    const detail =
      state.errorDetail ||
      (state.status === "succeeded"
        ? "The request finished without complete response evidence."
        : `The external turn ended with status ${state.status}.`);
    this.output.chatRequestFailed(
      state.sessionId,
      state.requestId,
      state.status,
      code,
      detail,
      state.ownerUrl,
    );
    return 1;
  }

  private async request(
    url: string,
    credential: StatusWorkspaceCredential,
    options: JsonRequestOptions,
    expected: number[],
    signal?: AbortSignal,
  ): Promise<JsonResponse> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await requestTargetJson(
          this.fetcher,
          this.authorization,
          url,
          credential,
          {
            ...(options.method === "POST" ? { timeoutMs: 60_000 } : {}),
            ...options,
            headers: {
              ...options.headers,
              "User-Agent": `TeamClaws-CLI/${PACKAGE_VERSION}`,
            },
            ...(signal ? { signal } : {}),
          },
        );
        if (expected.includes(response.status)) return response;
        if (
          options.method !== "POST" &&
          response.status === 429 &&
          attempt < 2
        ) {
          await this.wait(retryAfter(response) * 1_000, signal);
          continue;
        }
        throw errorFromResponse(response, "external_chat_failed");
      } catch (error) {
        if (
          error instanceof TeamClawsError &&
          error.retryable &&
          options.method !== "POST" &&
          attempt < 2 &&
          !signal?.aborted
        ) {
          await this.wait((attempt + 1) * 1_000, signal);
          continue;
        }
        throw error;
      }
    }
    throw new TeamClawsError(
      "external_chat_failed",
      "The workspace did not complete the external chat request.",
      { exitCode: 5 },
    );
  }
}

function requireReadyHandoff(
  handoff: ExternalChatHandoff,
): Extract<ExternalChatHandoff, { status: "ready" }> {
  if (handoff.status === "ready") return handoff;
  throw new TeamClawsError(
    handoff.status === "re_pair_required"
      ? "re_pair_required"
      : "external_chat_unavailable",
    handoff.status === "re_pair_required"
      ? "Re-pair this workspace before starting external chat."
      : "The workspace external chat client is temporarily unavailable.",
    { exitCode: handoff.status === "re_pair_required" ? 3 : 5 },
  );
}

function requirePairingScopes(value: unknown): void {
  if (!isObject(value) || !isObject(value.paired_device)) {
    throw invalidChatResponse();
  }
  const scopes = value.paired_device.scopes;
  if (!Array.isArray(scopes)) throw invalidChatResponse();
  const approved = new Set(scopes.map(String));
  if ([...REQUIRED_SCOPES].some((scope) => !approved.has(scope))) {
    throw new TeamClawsError(
      "re_pair_required",
      "Re-pair this workspace to grant the required external chat scopes.",
      { exitCode: 3 },
    );
  }
}

function parseCapabilities(
  value: unknown,
  inventoryOnly = false,
): Capabilities {
  if (!isObject(value) || value.contract_version !== 1) {
    throw invalidChatResponse();
  }
  if (!isObject(value.identity)) throw invalidChatResponse();
  requireString(value.identity.alias, "external identity alias", 200);
  if (!Array.isArray(value.approved_scopes)) throw invalidChatResponse();
  // Successful paired listing is authorized by the endpoint, not by this
  // informational scope list. Session flows retain their existing checks.
  const approved = new Set(value.approved_scopes.map(String));
  if (
    !inventoryOnly &&
    [...REQUIRED_SCOPES].some((scope) => !approved.has(scope))
  ) {
    throw new TeamClawsError(
      "re_pair_required",
      "Re-pair this workspace to grant the required external chat scopes.",
      { exitCode: 3 },
    );
  }
  if (!Array.isArray(value.providers) || value.providers.length > 32) {
    throw invalidChatResponse();
  }
  const providers = value.providers.map((provider) => {
    if (!isObject(provider) || !Array.isArray(provider.models)) {
      throw invalidChatResponse();
    }
    const id = requireString(provider.id, "provider identifier", 120);
    // Catalogs grow independently of the CLI; HTTP response bytes are bounded.
    const models = provider.models.map((model) => {
      if (!isObject(model)) throw invalidChatResponse();
      const reasoningValues = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
        : [];
      const reasoning = new Set(
        reasoningValues.map((item) =>
          isObject(item)
            ? requireString(item.effort, "reasoning effort", 40)
            : requireString(item, "reasoning effort", 40),
        ),
      );
      return {
        id: requireString(model.id, "model identifier", 255),
        reasoning,
        fast: model.fast_mode_available === true,
      };
    });
    return { id, models };
  });
  if (!isObject(value.policy)) throw invalidChatResponse();
  if (
    value.recommended_selection !== null &&
    !isObject(value.recommended_selection)
  )
    throw invalidChatResponse();
  const recommended =
    value.recommended_selection === null
      ? null
      : {
          provider_key: requireString(
            value.recommended_selection.provider_key,
            "provider identifier",
            120,
          ),
          model_name: requireString(
            value.recommended_selection.model_name,
            "model identifier",
            255,
          ),
          reasoning_effort:
            typeof value.recommended_selection.reasoning_effort === "string"
              ? value.recommended_selection.reasoning_effort
              : "",
          fast_mode: value.recommended_selection.fast_mode === true,
        };
  if (!isObject(value.limits)) throw invalidChatResponse();
  const capabilities = {
    providers,
    recommended,
    pollSeconds: requireInteger(
      value.limits.recommended_poll_seconds ?? 3,
      "polling interval",
      1,
      60,
    ),
    messageChars: requireInteger(
      value.limits.message_chars,
      "message limit",
      1,
      1_000_000,
    ),
    allowFast: value.policy.allow_fast_mode === true,
  };
  if (!inventoryOnly && recommended) resolveSelection(capabilities, {});
  return capabilities;
}

export function parseCapabilityInventory(value: unknown): CapabilityInventory {
  const parsed = parseCapabilities(value, true);
  // Project only public capability fields; never return the server response itself.
  if (
    !isObject(value) ||
    !isObject(value.identity) ||
    !Array.isArray(value.approved_scopes)
  )
    throw invalidChatResponse();
  return {
    contract_version: 1,
    identity: {
      alias: requireString(
        value.identity.alias,
        "external identity alias",
        200,
      ),
    },
    approved_scopes: value.approved_scopes.filter(
      (scope): scope is string =>
        typeof scope === "string" && REQUIRED_SCOPES.has(scope),
    ),
    providers: parsed.providers.map((provider) => ({
      id: provider.id,
      models: provider.models.map((model) => ({
        id: model.id,
        supported_reasoning_levels: [...model.reasoning],
        fast_mode_available: model.fast,
      })),
    })),
    recommended_selection: parsed.recommended,
    policy: { allow_fast_mode: parsed.allowFast },
    limits: {
      message_chars: parsed.messageChars,
      recommended_poll_seconds: parsed.pollSeconds,
    },
  };
}

// Start accepts explicit choices independently of advertised default selection.
// Keep the legacy resolver used by send/watch response validation unchanged.
function resolveStartSelection(
  capabilities: Capabilities,
  requested: Pick<
    ChatStartOptions,
    "provider" | "model" | "reasoning" | "fastMode"
  >,
): ChatSelection {
  const recommendation = capabilities.recommended;
  const recommendedModel = capabilities.providers
    .find((provider) => provider.id === recommendation?.provider_key)
    ?.models.find((model) => model.id === recommendation?.model_name);
  const usable =
    recommendation &&
    recommendedModel &&
    (!recommendation.reasoning_effort ||
      recommendedModel.reasoning.has(recommendation.reasoning_effort)) &&
    (!recommendation.fast_mode ||
      (recommendedModel.fast && capabilities.allowFast))
      ? recommendation
      : null;
  const providerKey = requested.provider ?? usable?.provider_key;
  const modelName = requested.model ?? usable?.model_name;
  if (providerKey === undefined || modelName === undefined) {
    throw new TeamClawsError(
      "selection_unavailable",
      "No usable default is available. Specify the missing provider and model choices.",
      { exitCode: 4 },
    );
  }
  const model = capabilities.providers
    .find((provider) => provider.id === providerKey)
    ?.models.find((item) => item.id === modelName);
  if (!model) {
    throw new TeamClawsError(
      "selection_unavailable",
      "The requested provider or model is not advertised by this workspace.",
      { exitCode: 4 },
    );
  }
  const defaultsCompatible =
    usable &&
    (!usable.reasoning_effort ||
      model.reasoning.has(usable.reasoning_effort)) &&
    (!usable.fast_mode || (model.fast && capabilities.allowFast));
  const selection = {
    provider_key: providerKey,
    model_name: modelName,
    reasoning_effort:
      requested.reasoning ??
      (defaultsCompatible ? usable.reasoning_effort : ""),
    fast_mode:
      requested.fastMode ??
      (defaultsCompatible
        ? usable.fast_mode
        : model.fast && capabilities.allowFast),
  };
  // Reuse existing membership/settings checks with the resolved selection only.
  return resolveSelection({ ...capabilities, recommended: selection }, {});
}

function resolveSelection(
  capabilities: Capabilities,
  requested: Pick<
    ChatStartOptions,
    "provider" | "model" | "reasoning" | "fastMode"
  >,
): ChatSelection {
  if (!capabilities.recommended) {
    throw new TeamClawsError(
      "external_chat_unavailable",
      "No recommended provider and model are currently available.",
      { exitCode: 5 },
    );
  }
  const selection = {
    provider_key: requested.provider ?? capabilities.recommended.provider_key,
    model_name: requested.model ?? capabilities.recommended.model_name,
    reasoning_effort:
      requested.reasoning ?? capabilities.recommended.reasoning_effort,
    fast_mode: requested.fastMode ?? capabilities.recommended.fast_mode,
  };
  const provider = capabilities.providers.find(
    (item) => item.id === selection.provider_key,
  );
  const model = provider?.models.find(
    (item) => item.id === selection.model_name,
  );
  if (!provider || !model) {
    throw new TeamClawsError(
      "selection_unavailable",
      "The requested provider or model is not advertised by this workspace.",
      { exitCode: 4 },
    );
  }
  if (
    selection.reasoning_effort &&
    !model.reasoning.has(selection.reasoning_effort)
  ) {
    throw new TeamClawsError(
      "selection_unavailable",
      "The requested reasoning effort is not advertised for this model.",
      { exitCode: 4 },
    );
  }
  if (selection.fast_mode && (!model.fast || !capabilities.allowFast)) {
    throw new TeamClawsError(
      "selection_unavailable",
      "Fast mode is not available for this device and model.",
      { exitCode: 4 },
    );
  }
  return selection;
}

function validateMessage(value: string, capabilities: Capabilities): string {
  const message = value.trim();
  if (!message || message.length > capabilities.messageChars) {
    throw new TeamClawsError(
      "invalid_message",
      `The message must contain 1-${capabilities.messageChars} characters.`,
      { exitCode: 2 },
    );
  }
  return message;
}

function parseRequest(
  value: unknown,
  origin: string,
  fallbackOwnerUrl?: unknown,
): RequestState {
  if (!isObject(value)) throw invalidChatResponse();
  const status = requireString(value.status, "request status", 40);
  if (!PENDING_STATUSES.has(status) && !TERMINAL_STATUSES.has(status)) {
    throw invalidChatResponse();
  }
  const ownerUrl = requireOwnerUrl(
    value.owner_conversation_url ?? fallbackOwnerUrl,
    origin,
  );
  const rawMessages = value.response_messages ?? [];
  if (!Array.isArray(rawMessages) || rawMessages.length > 1_000) {
    throw invalidChatResponse();
  }
  const messages = rawMessages.map((message) => {
    if (!isObject(message)) throw invalidChatResponse();
    return {
      id: requireInteger(
        message.id,
        "response message identifier",
        1,
        2 ** 53 - 1,
      ),
      body: typeof message.body_text === "string" ? message.body_text : "",
      provider:
        typeof message.provider_key === "string" ? message.provider_key : "",
      model: typeof message.model_name === "string" ? message.model_name : "",
    };
  });
  const error = isObject(value.error) ? value.error : {};
  return {
    requestId: validUuid(value.request_id),
    sessionId: validUuid(value.session_id),
    status,
    revision: requireInteger(
      value.revision,
      "request revision",
      1,
      2 ** 31 - 1,
    ),
    responseCursor: requireInteger(
      value.response_cursor,
      "response cursor",
      0,
      2 ** 53 - 1,
    ),
    ownerUrl,
    messages,
    errorCode: typeof error.code === "string" ? error.code.slice(0, 64) : "",
    errorDetail:
      typeof error.detail === "string" ? error.detail.slice(0, 500) : "",
  };
}

function requireOwnerUrl(value: unknown, origin: string): string {
  const url = requireHttpsUrl(value, "owner conversation address");
  if (url.origin !== origin || !url.pathname.startsWith("/teamclaws-admin/")) {
    throw invalidChatResponse();
  }
  return url.toString();
}

function validUuid(value: unknown): string {
  return normalizeUuid(value, "identifier");
}

function historyText(value: unknown): string {
  if (typeof value !== "string") throw invalidChatResponse();
  return value;
}

function invalidChatResponse(): TeamClawsError {
  return new TeamClawsError(
    "invalid_external_chat_response",
    "The workspace returned an invalid external chat response.",
    { exitCode: 9 },
  );
}

function retryAfter(response: JsonResponse): number {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isInteger(header) && header > 0 && header <= 60) return header;
  if (isObject(response.body)) {
    const seconds = Number(response.body.retry_after_seconds);
    if (Number.isInteger(seconds) && seconds > 0 && seconds <= 60)
      return seconds;
  }
  return 1;
}

async function waitFor(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TeamClawsError("cancelled", "Chat monitoring was cancelled."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TeamClawsError("cancelled", "Chat monitoring was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
