import { OUTPUT_SCHEMA_VERSION } from "./constants.js";
import type { TeamClawsError } from "./errors.js";
import type {
  AgentAction,
  CapabilityInventory,
  ExternalChatHandoff,
  PairingStatus,
  SafeUser,
  ServerSummary,
  WorkspaceCredential,
} from "./types.js";

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
    });
    if (!this.json) this.stdout.write(`${url}\n`);
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
    if (user) event.user = user;
    if (expiresAt) event.expires_at = expiresAt;
    this.event(event);
    if (!this.json) {
      this.stdout.write(
        status === "signed_in" && user
          ? `Signed in as ${user.display_name} (${user.email}).\n`
          : "Not signed in to TeamClaws.\n",
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

  servers(servers: ServerSummary[]): void {
    this.event({
      schema_version: OUTPUT_SCHEMA_VERSION,
      event: "servers_list",
      status: "success",
      servers,
    });
    if (!this.json) {
      if (servers.length === 0) {
        this.stdout.write(
          "No pairing-ready TeamClaws workspaces are available.\n",
        );
        return;
      }
      servers.forEach((server, index) => {
        this.stdout.write(
          `${index + 1}. ${server.alias} — ${server.server_id} — ${server.workspace_url}\n`,
        );
      });
    }
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
