export type JsonObject = Record<string, unknown>;

export type MachineUserRole = "user" | "staff" | "superuser";

export type UsersListResult = {
  ok: true;
  action: "list";
  scope: "access_group";
  members: Array<{
    email: string;
    role: MachineUserRole;
    is_owner: boolean;
    sudo_enabled?: boolean;
  }>;
  invites: Array<{
    email: string;
    role: MachineUserRole;
    status: "pending" | "accepted";
    is_expired: boolean;
    sudo_enabled?: boolean;
  }>;
};

export type UsersAddResult = {
  ok: true;
  code: "invited" | "already_pending" | "already_member" | "already_owner";
  action: "add";
  scope: "access_group";
  email: string;
  requested_role: MachineUserRole;
  sudo_enabled?: boolean;
};

export type UsersRemoveResult = {
  ok: true;
  code: "removed" | "revoked";
  action: "remove";
  scope: "access_group";
  email: string;
};

export type SafeUser = {
  id: string;
  display_name: string;
  email: string;
};

export type ServerSummary = {
  server_id: string;
  alias: string;
  description?: string;
  resources?: Array<{
    type: string;
    name: string;
    permissions?: Record<string, string>;
    skills: string[];
  }>;
  custom_alias?: string;
  can_edit_metadata?: boolean;
  is_owner?: boolean;
  tier_name?: string | null;
  is_free?: boolean | null;
  free_expires_at?: string | null;
  workspace_url: string;
  status: string;
  workspace_state?: "building" | "running" | "powered_off" | "error" | null;
  status_since?: string | null;
  created_at?: string;
  deployment_status?: string | null;
  pairing_ready: boolean;
  version?: string | null;
  available_version?: string | null;
  update_available?: boolean | null;
};

export type ServerMetadataUpdate = { alias?: string; description?: string };

export type GitAccessLevel = "none" | "read" | "write";

export type EmailProvider = "google" | "microsoft";
export type EmailAssignmentPolicy =
  "read_only" | "write_with_approval_read" | "write_read";
export type EmailAccount = {
  provider: EmailProvider;
  account_id: number;
  email: string;
};
export type EmailAccountList = {
  accounts: Array<
    EmailAccount & { permission_level: "read_only" | "read_write" }
  >;
  connect_url: string;
};
export type EmailAssignmentList = {
  server_id: string;
  accounts: Array<EmailAccount & { assignment_policy: EmailAssignmentPolicy }>;
};
export type EmailAssignmentResult = EmailAccount & {
  server_id: string;
  assignment_policy: EmailAssignmentPolicy | null;
  code: "permissions_set" | "removed" | "already_unassigned";
};
export type FeedbackLabel = "bug" | "enhancement";
export type FeedbackResult = {
  id: string;
  source: "cli";
  label: FeedbackLabel;
  title: string;
  status: "submitted";
  github_issue_number: number;
  github_issue_url: string;
  remaining_today: number;
};

export type GitPermissionMap = {
  issues: GitAccessLevel;
  contents: GitAccessLevel;
  pull_requests: GitAccessLevel;
  workflows: Exclude<GitAccessLevel, "read">;
};

export type GitRepository = { repository_id: number; full_name: string };
export type GitRepositoryList = {
  repositories: GitRepository[];
  connect_url: string;
};
export type GitRepositoryAssignment = GitRepository & {
  permissions: GitPermissionMap;
};
export type GitAssignmentList = {
  server_id: string;
  repositories: GitRepositoryAssignment[];
};
export type GitAssignmentResult = GitRepositoryAssignment & {
  server_id: string;
  code: "permissions_set" | "removed" | "already_unassigned";
};

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
  version: 2;
  server_id: string;
  origin: string;
  display_name: string;
  workspace_name?: string;
  device_id: string;
  pairing_id: string;
  device_token: string;
  requester_sub: string;
  authorization_id: string;
  machine_jkt: string;
  created_at: string;
};

export type StatusWorkspaceCredential = Pick<
  WorkspaceCredential,
  | "version"
  | "server_id"
  | "origin"
  | "display_name"
  | "workspace_name"
  | "device_id"
  | "device_token"
  | "pairing_id"
  | "requester_sub"
  | "authorization_id"
  | "machine_jkt"
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

export type ChatHistoryEntry = {
  chat_id: string;
  name: string;
  surface: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
  owner_conversation_url: string;
};

export type ChatHistoryMessage = {
  id: number;
  role: string;
  body_text: string;
  status: string;
  created_at: string;
};

export type CapabilityInventory = {
  contract_version: 1;
  provider_availability?: {
    code: "ready" | "no_provider_paired" | "provider_unavailable";
    setup_path: "/teamclaws-admin/";
  };
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
  pairing_id: string;
  server_id: string;
  origin: string;
  requester_sub: string;
  authorization_id: string;
  machine_jkt: string;
};
