import type { ConversationReference } from "./storage.js";
import { OUTPUT_SCHEMA_VERSION } from "./constants.js";
import type { TeamClawsError } from "./errors.js";
import type {
  AgentAction,
  ChatHistoryEntry,
  ChatHistoryMessage,
  CapabilityInventory,
  ExternalChatHandoff,
  PairingStatus,
  SafeUser,
  ServerMetadata,
  ServerSummary,
  WorkspaceCredential,
} from "./types.js";

const LOGIN_ACCOUNT_GUIDANCE =
  "Use your TeamClaws account. If you already have a workspace, use the account that has access to it. This may use a different email from your AI assistant account.";

export type Writable = { write(chunk: string): unknown };

export class Output {
  constructor(
    private readonly json: boolean,
    private readonly stdout: Writable = process.stdout,
    private readonly stderr: Writable = process.stderr,
  ) {}

  loginBrowser(url: string): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "login_browser_required",
      url,
      label: "Sign in to TeamClaws",
      account_guidance: LOGIN_ACCOUNT_GUIDANCE,
    });
    if (!this.json)
      this.stdout.write(
        `Sign in to TeamClaws: ${url}\n${LOGIN_ACCOUNT_GUIDANCE}\n`,
      );
  }

  pairingBrowser(
    url: string,
    userCode: string,
    agentAction?: AgentAction,
  ): void {
    const event: Record<string, unknown> = {
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "pairing_browser_required",
      url,
      user_code: userCode,
    };
    if (agentAction) event.agent_action = agentAction;
    this.event(event);
    if (!this.json) {
      if (agentAction) {
        this.stdout.write(agentAction.message_markdown);
        if (!agentAction.message_markdown.endsWith("\n")) {
          this.stdout.write("\n");
        }
      } else {
        this.stdout.write(
          `Approve pairing in your browser:\n${url}\nPairing code: ${userCode}\n`,
        );
      }
    }
  }

  loginComplete(user: SafeUser): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "login_complete",
      status: "success",
      user,
    });
    if (!this.json)
      this.stdout.write(
        `Signed in to TeamClaws as ${user.display_name} (${user.email}).\n`,
      );
  }

  authStatus(
    status: "signed_in" | "signed_out",
    user?: SafeUser,
    expiresAt?: string,
  ): void {
    const event: Record<string, unknown> = {
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "auth_status",
      status,
    };
    if (status === "signed_out") event.login_command = "teamclaws login --json";
    if (user) event.user = user;
    if (expiresAt) event.expires_at = expiresAt;
    this.event(event);
    if (!this.json) {
      this.stdout.write(
        status === "signed_in" && user
          ? `Signed in as ${user.display_name} (${user.email}).\n`
          : "Not signed in to TeamClaws. Run `teamclaws login` to sign in.\n",
      );
    }
  }

  logoutComplete(remoteConfirmed: boolean): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "logout_complete",
      status: remoteConfirmed ? "success" : "local_only_warning",
    });
    if (!this.json) {
      this.stdout.write(
        remoteConfirmed
          ? "Signed out from TeamClaws on this computer.\n"
          : "Signed out on this computer. TeamClaws could not confirm remote revocation.\n",
      );
    }
  }

  servers(servers: ServerSummary[], workspaceCount?: number): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "servers_list",
      status: "success",
      servers,
      workspace_count: workspaceCount ?? null,
      discovery_state:
        workspaceCount === 0
          ? "no_workspaces"
          : servers.some((server) => server.pairing_ready)
            ? "ready"
            : workspaceCount === undefined && servers.length === 0
              ? "unknown"
              : "not_ready",
    });
    if (!this.json) {
      if (servers.length === 0) {
        this.stdout.write(
          workspaceCount === 0
            ? "No TeamClaws workspaces are available to this account. Purchase a workspace at https://teamclaws.com/app/.\n"
            : "No pairing-ready TeamClaws workspaces are listed. Check existing workspaces at https://teamclaws.com/app/ before considering a purchase.\n",
        );
        return;
      }
      servers.forEach((server, index) => {
        this.stdout.write(
          `${index + 1}. ${server.alias} — ${server.server_id} — ${server.workspace_url} — ${server.pairing_ready ? "ready to pair" : "not ready to pair"}\n`,
        );
        if (server.description) this.stdout.write(`   ${server.description}\n`);
      });
    }
  }

  serverMetadataPrompt(server: ServerSummary): void {
    const updateCommand = `teamclaws servers update ${server.server_id} --name "Your server name" --description "What this server is for"`;
    const guidance = `You can always change the name and description later with: ${updateCommand}`;
    const question =
      "Would you like to set the server name and description now?";
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "server_metadata_prompt",
      server,
      question,
      message: `Your server ${JSON.stringify(server.alias)} is missing a user-defined name or description. ${question} ${guidance}`,
      update_command: updateCommand,
    });
    if (!this.json)
      this.stdout.write(
        `Your server ${JSON.stringify(server.alias)} is missing a user-defined name or description.\n${guidance}\n`,
      );
  }

  serverMetadataUpdated(server: ServerMetadata): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "server_metadata_updated",
      status: "success",
      server,
    });
    if (!this.json)
      this.stdout.write(`Updated server details for ${server.alias}.\n`);
  }

  pairingComplete(
    serverId: string,
    origin: string,
    displayName: string,
    externalChatHandoff?: ExternalChatHandoff,
    capabilities?: CapabilityInventory | null,
    generatedAt?: string | null,
  ): void {
    const workspace = {
      server_id: serverId,
      origin,
      display_name: displayName,
    };
    const event: Record<string, unknown> = {
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "pairing_complete",
      status: "success",
      workspace,
    };
    if (externalChatHandoff) event.external_chat_handoff = externalChatHandoff;
    if (capabilities !== undefined) {
      event.external_chat_capabilities = capabilities;
      event.external_chat_capabilities_generated_at = generatedAt ?? null;
    }
    this.event(event);
    if (!this.json) {
      this.stdout.write(`Paired ${displayName} (${origin}).\n`);
      if (capabilities) this.renderInventory(capabilities, generatedAt);
      else
        this.stdout.write(
          "Capabilities unavailable; use chat capabilities to refresh.\n",
        );
    }
  }

  pairingStatus(
    status: PairingStatus,
    workspace?: Pick<
      WorkspaceCredential,
      "server_id" | "origin" | "display_name"
    >,
  ): void {
    const event: Record<string, unknown> = {
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "pairing_status",
      status,
    };
    if (workspace) event.workspace = workspace;
    this.event(event);
    if (this.json) return;
    if (status === "paired" && workspace) {
      this.stdout.write(`Paired with ${workspace.origin}.\n`);
      return;
    }
    if (status === "credential_rejected" && workspace) {
      this.stdout.write(`Saved pairing rejected by ${workspace.origin}.\n`);
      return;
    }
    if (status === "unreachable" && workspace) {
      this.stdout.write(
        `Could not verify pairing with ${workspace.origin} within five seconds.\n`,
      );
      return;
    }
    if (status === "unreachable") {
      this.stdout.write("Could not safely verify the selected pairing.\n");
      return;
    }
    this.stdout.write("Not paired with the selected workspace.\n");
  }

  capabilityInventory(
    workspace: { server_id: string; origin: string },
    capabilities: CapabilityInventory,
  ): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "chat_capabilities",
      status: "success",
      source: "refresh",
      workspace,
      external_chat_capabilities: capabilities,
    });
    if (!this.json) this.renderInventory(capabilities, undefined, true);
  }

  private renderInventory(
    capabilities: CapabilityInventory,
    generatedAt?: string | null,
    checkRecommendation = false,
  ): void {
    if (
      !capabilities.providers.some((provider) => provider.models.length > 0)
    ) {
      this.stdout.write("No provider/model is currently available.\n");
    }
    for (const provider of capabilities.providers) {
      for (const model of provider.models) {
        this.stdout.write(
          `${provider.id}/${model.id} — reasoning: ${model.supported_reasoning_levels.join(", ") || "none"}; fast: ${model.fast_mode_available && capabilities.policy.allow_fast_mode ? "available" : "unavailable"}\n`,
        );
      }
    }
    const recommendation = capabilities.recommended_selection;
    const model = capabilities.providers
      .find((provider) => provider.id === recommendation?.provider_key)
      ?.models.find((item) => item.id === recommendation?.model_name);
    const usable =
      recommendation &&
      model &&
      (!recommendation.reasoning_effort ||
        model.supported_reasoning_levels.includes(
          recommendation.reasoning_effort,
        )) &&
      (!recommendation.fast_mode ||
        (model.fast_mode_available && capabilities.policy.allow_fast_mode));
    this.stdout.write(
      checkRecommendation && !usable
        ? "No usable recommendation.\n"
        : recommendation
          ? `Recommended: ${recommendation.provider_key}/${recommendation.model_name}.\n`
          : "No recommended provider/model.\n",
    );
    this.stdout.write(
      generatedAt
        ? `Snapshot generated: ${generatedAt}.\n`
        : "Generation time is not supplied by the capabilities endpoint.\n",
    );
  }

  chatHistory(chats: ChatHistoryEntry[], nextAfterId: number | null): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "chat_history",
      status: "success",
      source: "workspace",
      chats,
      next_after_id: nextAfterId,
    });
    if (!this.json)
      for (const chat of chats)
        this.stdout.write(
          `${chat.chat_id} — ${chat.name} — ${chat.owner_conversation_url}\n`,
        );
  }

  chatMessages(
    chatId: string,
    messages: ChatHistoryMessage[],
    latestMessageId: number,
    hasMore: boolean,
  ): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "chat_messages",
      status: "success",
      source: "workspace",
      chat_id: chatId,
      messages,
      latest_message_id: latestMessageId,
      has_more: hasMore,
    });
    if (!this.json)
      for (const message of messages)
        this.stdout.write(
          `${message.id} ${message.role}: ${message.body_text}\n`,
        );
  }

  chatSessionsList(
    workspace: { server_id: string; origin: string },
    records: ConversationReference[],
  ): void {
    const sessions = records.map((record) => ({
      session_id: record.session_id,
      request_id: record.request_id,
      owner_conversation_url: record.owner_conversation_url,
      revision: record.revision,
      response_cursor: record.response_cursor,
      updated_at: record.updated_at,
    }));
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "chat_sessions_list",
      status: "success",
      source: "local",
      workspace: { server_id: workspace.server_id, origin: workspace.origin },
      sessions,
    });
    if (!this.json) {
      this.stdout.write(
        sessions.length
          ? "Locally recorded conversations:\n"
          : "No locally recorded conversations for this workspace and pairing. This is not the workspace conversation inventory.\n",
      );
      for (const item of sessions)
        this.stdout.write(
          `${item.session_id} — request ${item.request_id} — revision ${item.revision}, response cursor ${item.response_cursor} — ${item.owner_conversation_url}\n`,
        );
    }
  }

  chatReferenceRecovery(
    sessionId: string,
    requestId: string,
    ownerUrl: string,
    revision: number,
    responseCursor: number,
  ): void {
    this.externalChatEvent("chat_reference_recovery", {
      session_id: sessionId,
      request_id: requestId,
      owner_conversation_url: ownerUrl,
      revision,
      response_cursor: responseCursor,
    });
    if (!this.json)
      this.stdout.write(
        `Retain session ${sessionId}, request ${requestId}, revision ${revision}, response cursor ${responseCursor}: ${ownerUrl}\n`,
      );
  }

  chatCapabilities(selection: {
    provider_key: string;
    model_name: string;
    reasoning_effort: string;
    fast_mode: boolean;
  }): void {
    this.externalChatEvent("capabilities_resolved", {
      provider_key: selection.provider_key,
      model_name: selection.model_name,
      reasoning_effort: selection.reasoning_effort,
      fast_mode_effective: selection.fast_mode,
    });
    if (!this.json)
      this.stdout.write(
        `Using ${selection.provider_key}/${selection.model_name}.\n`,
      );
  }

  chatSessionCreated(
    sessionId: string,
    requestId: string,
    status: string,
    ownerUrl: string,
  ): void {
    this.externalChatEvent("session_created", {
      session_id: sessionId,
      request_id: requestId,
      status,
      owner_conversation_url: ownerUrl,
    });
    if (!this.json)
      this.stdout.write(`Created external chat session ${sessionId}.\n`);
  }

  chatRequestStatus(
    sessionId: string,
    requestId: string,
    status: string,
    revision: number,
  ): void {
    this.externalChatEvent("request_status_changed", {
      session_id: sessionId,
      request_id: requestId,
      status,
      revision,
    });
    if (!this.json) this.stdout.write(`Request status: ${status}.\n`);
  }

  chatApprovalRequired(
    sessionId: string,
    requestId: string,
    ownerUrl: string,
  ): void {
    this.externalChatEvent("approval_required", {
      session_id: sessionId,
      request_id: requestId,
      status: "awaiting_approval",
      owner_conversation_url: ownerUrl,
    });
    if (!this.json)
      this.stdout.write(`Owner approval required in TCChat: ${ownerUrl}\n`);
  }

  chatAssistantMessage(
    sessionId: string,
    requestId: string,
    messageId: number,
    body: string,
    provider: string,
    model: string,
  ): void {
    this.externalChatEvent("assistant_message", {
      session_id: sessionId,
      request_id: requestId,
      message_id: messageId,
      body_text: body,
      provider_key: provider,
      model_name: model,
    });
    if (!this.json) this.stdout.write(`${body}\n`);
  }

  chatRequestSucceeded(
    sessionId: string,
    requestId: string,
    responseCount: number,
    ownerUrl: string,
  ): void {
    this.externalChatEvent("request_succeeded", {
      session_id: sessionId,
      request_id: requestId,
      status: "succeeded",
      response_count: responseCount,
      owner_conversation_url: ownerUrl,
    });
    if (!this.json)
      this.stdout.write(`Open this conversation in TCChat: ${ownerUrl}\n`);
  }

  chatRequestFailed(
    sessionId: string,
    requestId: string,
    status: string,
    code: string,
    detail: string,
    ownerUrl: string,
  ): void {
    this.externalChatEvent("request_failed", {
      session_id: sessionId,
      request_id: requestId,
      status,
      error_code: code,
      error_detail: detail,
      owner_conversation_url: ownerUrl,
    });
    if (!this.json) this.stderr.write(`Error: ${detail}\n`);
  }

  error(error: TeamClawsError): void {
    const event: Record<string, unknown> = {
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "error",
      status: "error",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    if (error.retryAfterSeconds !== undefined) {
      event.retry_after_seconds = error.retryAfterSeconds;
    }
    if (this.json) this.stdout.write(`${JSON.stringify(event)}\n`);
    else this.stderr.write(`Error: ${error.message}\n`);
  }

  private event(event: Record<string, unknown>): void {
    if (this.json) this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  private externalChatEvent(
    event: string,
    facts: Record<string, unknown>,
  ): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event,
      ...facts,
    });
  }
}
