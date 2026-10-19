export type JsonObject = Record<string, unknown>;

export type SafeUser = {
  id: string;
  display_name: string;
  email: string;
};

export type ServerSummary = {
  server_id: string;
  alias: string;
  description?: string;
  custom_alias?: string;
  can_edit_metadata?: boolean;
  workspace_url: string;
  status: string;
  pairing_ready: boolean;
};

export type ServerMetadataUpdate = { alias?: string; description?: string };

export type ServerMetadata = {
  server_id: string;
  alias: string;
  description: string;
  custom_alias: string;
  can_edit_metadata: true;
};

export type WorkspaceInventory = {
  servers: ServerSummary[];
  workspace_count?: number;
};

export type PairingTarget =
  | { server_id: string; workspace_url?: never }
  | { workspace_url: string; server_id?: never };

export type DirectTarget = {
  origin: string;
  token_poll_path: string;
  cancellation_path: string;
  credential_verification_path: string;
};

export type AgentAction = {
  schema_version: 1;
  type: "deliver_and_stop";
  message_format: "markdown";
  message_markdown: string;
  expires_at: string;
};

export type PendingPairing = {
  contract_version: number;
  server_id: string;
  target: DirectTarget;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  status: "pending";
  device_code: string;
  agent_action?: AgentAction;
};

export type LoginCredential = {
  version: 1;
  token_type: "Bearer";
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

export type WorkspaceCredential = {
  version: 1;
  server_id: string;
  origin: string;
  display_name: string;
  device_id: string;
  device_token: string;
  created_at: string;
};

export type StatusWorkspaceCredential = Pick<
  WorkspaceCredential,
  | "version"
  | "server_id"
  | "origin"
  | "display_name"
  | "device_id"
  | "device_token"
>;

export type PairingStatus =
  "paired" | "not_paired" | "credential_rejected" | "unreachable";

export type ExternalChatHandoff =
  | {
      schema_version: 1;
      contract_version: 1;
      status: "ready";
      reason_codes: [];
      skill_url: string;
      skill_name: "teamclaws-external-chat-client";
      bundle_sha256: string;
      capabilities_url: "/teamclaws-admin/api/device-chat/v1/capabilities/";
      recommended_action: "load_skill";
    }
  | {
      schema_version: 1;
      contract_version: 1;
      status: "re_pair_required";
      reason_codes: string[];
      recommended_action: "re_pair";
    }
  | {
      schema_version: 1;
      contract_version: 1;
      status: "unavailable";
      reason_codes: string[];
      recommended_action: "retry_later";
    };

export type VerifiedWorkspace = {
  display_name: string;
  external_chat_handoff: ExternalChatHandoff;
};

export type CapabilityInventory = {
  contract_version: 1;
  identity: { alias: string };
  approved_scopes: string[];
  providers: Array<{
    id: string;
    models: Array<{
      id: string;
      supported_reasoning_levels: string[];
      fast_mode_available: boolean;
    }>;
  }>;
  recommended_selection: {
    provider_key: string;
    model_name: string;
    reasoning_effort: string;
    fast_mode: boolean;
  } | null;
  policy: { allow_fast_mode: boolean };
  limits: { message_chars: number; recommended_poll_seconds: number };
};

export type PairingCredential = {
  external_chat_capabilities?: unknown;
  external_chat_capabilities_generated_at?: unknown;
  device_id: string;
  device_token: string;
};
