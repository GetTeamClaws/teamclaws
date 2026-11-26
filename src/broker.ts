import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  TargetAuthorization,
  DurableAuthorization,
} from "./target-authorization.js";

import {
  API_BASE,
  CLIENT_NAME,
  CONTRACT_VERSION,
  MAX_CLIENT_LABEL_LENGTH,
  MAX_DEVICE_NAME_LENGTH,
  PACKAGE_VERSION,
} from "./constants.js";
import { TeamClawsError } from "./errors.js";
import { errorFromResponse, requestJson, type FetchLike } from "./http.js";
import type {
  EmailProvider,
  EmailAssignmentPolicy,
  EmailAccount,
  EmailAccountList,
  EmailAssignmentList,
  EmailAssignmentResult,
  FeedbackLabel,
  FeedbackResult,
  GitAccessLevel,
  GitAssignmentList,
  GitAssignmentResult,
  GitPermissionMap,
  GitRepository,
  GitRepositoryList,
  PairingTarget,
  PendingPairing,
  ServerMetadata,
  ServerMetadataUpdate,
  WorkspaceInventory,
} from "./types.js";
import {
  assertExactKeys,
  isObject,
  normalizeUuid,
  parsePendingPairing,
  parseWorkspaceInventory,
  requireInteger,
  requireString,
} from "./validation.js";

export type BrokerOptions = {
  fetcher?: FetchLike;
  deviceName?: () => string;
  authorization?: TargetAuthorization;
};

const CONNECTED_GITHUB_URL = "https://www.teamclaws.com/app/connected-github/";
const CONNECTED_EMAIL_URL = "https://www.teamclaws.com/app/connected-email/";
const GIT_PERMISSION_KEYS = [
  "issues",
  "contents",
  "pull_requests",
  "workflows",
] as const;

export class BrokerClient {
  private readonly fetcher: FetchLike;
  private readonly deviceName: () => string;
  private readonly authorization: TargetAuthorization | undefined;

  constructor(options: BrokerOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.deviceName = options.deviceName ?? hostname;
    this.authorization = options.authorization;
  }

  currentDeviceName(): string {
    return normalizedDeviceName(this.deviceName());
  }

  async servers(signal?: AbortSignal): Promise<WorkspaceInventory> {
    const url = `${API_BASE}servers/?include_inventory=1&include_description=1&include_editable_metadata=1&include_subscription=1&include_resources=1`;
    const response = await requestJson(this.fetcher, url, {
      headers: await this.issuerHeaders("GET", url),
      ...(signal ? { signal } : {}),
    });
    if (response.status === 401) {
      throw new TeamClawsError(
        "invalid_authentication",
        "The TeamClaws CLI authorization is inactive. Run `teamclaws login <email>` to authorize this computer again.",
        {
          exitCode: 3,
        },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw errorFromResponse(response, "server_discovery_failed");
    }
    return parseWorkspaceInventory(response.body);
  }

  async claimLiteTrial(signal?: AbortSignal): Promise<{
    workspace_id: string;
    expires_at: string | null;
  }> {
    const url = `${API_BASE}workspaces/claim/`;
    const response = await requestJson(this.fetcher, url, {
      method: "POST",
      headers: await this.issuerHeaders("POST", url),
      body: { confirm: true },
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200)
      throw errorFromResponse(response, "trial_claim_failed");
    if (
      !isObject(response.body) ||
      (response.body.expires_at !== null &&
        (typeof response.body.expires_at !== "string" ||
          !Number.isFinite(Date.parse(response.body.expires_at))))
    ) {
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned an invalid trial claim.",
        { exitCode: 9 },
      );
    }
    return {
      workspace_id: normalizeUuid(response.body.workspace_id),
      expires_at: response.body.expires_at,
    };
  }

  async updateServerMetadata(
    serverId: string,
    updates: ServerMetadataUpdate,
    signal?: AbortSignal,
  ): Promise<ServerMetadata> {
    if (
      Object.keys(updates).length === 0 ||
      (updates.alias !== undefined && [...updates.alias.trim()].length > 100) ||
      (updates.description !== undefined &&
        [...updates.description.trim()].length > 2_000)
    ) {
      throw new TeamClawsError(
        "invalid_server_metadata",
        "Provide a name of 100 characters or fewer and/or a description of 2000 characters or fewer.",
        { exitCode: 2 },
      );
    }
    const id = normalizeUuid(serverId);
    const url = `${API_BASE}servers/${id}/metadata/`;
    const response = await requestJson(this.fetcher, url, {
      method: "POST",
      headers: await this.issuerHeaders("POST", url),
      body: updates,
      ...(signal ? { signal } : {}),
    });
    if (response.status < 200 || response.status >= 300)
      throw errorFromResponse(response, "server_metadata_update_failed");
    if (!isObject(response.body)) throw invalidMetadataResponse();
    assertExactKeys(
      response.body,
      ["server"],
      [],
      "workspace metadata response",
    );
    return editableServer(response.body.server, id);
  }

  async gitRepositories(signal?: AbortSignal): Promise<GitRepositoryList> {
    const body = await this.gitRequest(
      "GET",
      `${API_BASE}github-repositories/`,
      signal,
    );
    assertExactKeys(
      body,
      ["repositories", "connect_url"],
      [],
      "repository list",
    );
    if (
      !Array.isArray(body.repositories) ||
      body.connect_url !== CONNECTED_GITHUB_URL
    )
      throw invalidGitResponse();
    return {
      repositories: body.repositories.map((row: unknown) => {
        if (!isObject(row)) throw invalidGitResponse();
        assertExactKeys(row, ["repository_id", "full_name"], [], "repository");
        return gitRepository(row);
      }),
      connect_url: body.connect_url,
    };
  }

  async emailAccounts(signal?: AbortSignal): Promise<EmailAccountList> {
    const body = await this.emailRequest(
      "GET",
      `${API_BASE}email-accounts/`,
      undefined,
      signal,
    );
    if (
      !Array.isArray(body.accounts) ||
      body.connect_url !== CONNECTED_EMAIL_URL
    )
      throw invalidEmailResponse();
    return {
      accounts: body.accounts.map((row: unknown) => {
        if (
          !isObject(row) ||
          (row.permission_level !== "read_only" &&
            row.permission_level !== "read_write")
        )
          throw invalidEmailResponse();
        return { ...emailAccount(row), permission_level: row.permission_level };
      }),
      connect_url: CONNECTED_EMAIL_URL,
    };
  }

  async emailAssignments(
    serverId: string,
    signal?: AbortSignal,
  ): Promise<EmailAssignmentList> {
    const id = normalizeUuid(serverId);
    const body = await this.emailRequest(
      "GET",
      `${API_BASE}servers/${id}/email-accounts/`,
      undefined,
      signal,
    );
    if (body.server_id !== id || !Array.isArray(body.accounts))
      throw invalidEmailResponse();
    return {
      server_id: id,
      accounts: body.accounts.map((row: unknown) => {
        if (!isObject(row)) throw invalidEmailResponse();
        return {
          ...emailAccount(row),
          assignment_policy: emailPolicy(row.assignment_policy),
        };
      }),
    };
  }

  async changeEmailAssignment(
    serverId: string,
    provider: EmailProvider,
    accountId: number,
    policy?: EmailAssignmentPolicy,
    signal?: AbortSignal,
  ): Promise<EmailAssignmentResult> {
    const id = normalizeUuid(serverId);
    const body = await this.emailRequest(
      policy ? "POST" : "DELETE",
      `${API_BASE}servers/${id}/email-accounts/${provider}/${accountId}/`,
      policy ? { assignment_policy: policy } : undefined,
      signal,
    );
    const account = emailAccount(body);
    if (
      body.server_id !== id ||
      account.provider !== provider ||
      account.account_id !== accountId
    )
      throw invalidEmailResponse();
    const code = body.code;
    if (policy) {
      const effective = emailPolicy(body.assignment_policy);
      if (
        code !== "permissions_set" ||
        (effective !== policy && effective !== "read_only")
      )
        throw invalidEmailResponse();
      return { ...account, server_id: id, code, assignment_policy: effective };
    }
    if (
      (code !== "removed" && code !== "already_unassigned") ||
      body.assignment_policy !== null
    )
      throw invalidEmailResponse();
    return { ...account, server_id: id, code, assignment_policy: null };
  }

  private async emailRequest(
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: { assignment_policy: EmailAssignmentPolicy },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await requestJson(this.fetcher, url, {
      method,
      headers: await this.issuerHeaders(method, url),
      ...(body ? { body } : {}),
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) {
      const error = errorFromResponse(response, "email_permissions_failed");
      if (
        error.code === "account_unavailable" &&
        isObject(response.body) &&
        isObject(response.body.error) &&
        response.body.error.connect_url === CONNECTED_EMAIL_URL
      )
        throw new TeamClawsError(error.code, error.message, {
          exitCode: error.exitCode,
          connectUrl: CONNECTED_EMAIL_URL,
        });
      throw error;
    }
    if (!isObject(response.body)) throw invalidEmailResponse();
    return response.body;
  }

  async submitFeedback(
    label: FeedbackLabel,
    title: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<FeedbackResult> {
    const url = `${API_BASE}feedback/`;
    const response = await requestJson(this.fetcher, url, {
      method: "POST",
      headers: await this.issuerHeaders("POST", url),
      body: { label, title, body },
      ...(signal ? { signal } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      const error = errorFromResponse(response, "feedback_failed");
      const errorBody = isObject(response.body) ? response.body : {};
      const detail = errorBody.detail;
      const fieldErrors = ["title", "body", "non_field_errors"]
        .flatMap((field) => {
          const messages = errorBody[field];
          return Array.isArray(messages)
            ? messages
                .filter(
                  (message): message is string => typeof message === "string",
                )
                .map((message) => `${field}: ${message}`)
            : [];
        })
        .join(" ");
      throw new TeamClawsError(
        error.code,
        typeof detail === "string" ? detail : fieldErrors || error.message,
        { exitCode: error.exitCode },
      );
    }
    const result = response.body;
    if (
      !isObject(result) ||
      result.source !== "cli" ||
      result.label !== label ||
      result.title !== title ||
      result.status !== "submitted" ||
      !Number.isSafeInteger(result.github_issue_number) ||
      Number(result.github_issue_number) <= 0 ||
      !Number.isSafeInteger(result.remaining_today) ||
      Number(result.remaining_today) < 0
    )
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned an invalid feedback receipt.",
        { exitCode: 9 },
      );
    const issueUrl = requireString(
      result.github_issue_url,
      "feedback issue URL",
      2048,
    );
    if (!issueUrl.startsWith("https://github.com/"))
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned an invalid feedback issue URL.",
        { exitCode: 9 },
      );
    return {
      id: normalizeUuid(result.id),
      source: "cli",
      label,
      title,
      status: "submitted",
      github_issue_number: Number(result.github_issue_number),
      github_issue_url: issueUrl,
      remaining_today: Number(result.remaining_today),
    };
  }

  async gitAssignments(
    serverId: string,
    signal?: AbortSignal,
  ): Promise<GitAssignmentList> {
    const id = normalizeUuid(serverId);
    const body = await this.gitRequest(
      "GET",
      `${API_BASE}servers/${id}/github-repositories/`,
      signal,
    );
    assertExactKeys(
      body,
      ["server_id", "repositories"],
      [],
      "repository assignment list",
    );
    if (body.server_id !== id || !Array.isArray(body.repositories))
      throw invalidGitResponse();
    return {
      server_id: id,
      repositories: body.repositories.map((row: unknown) => {
        if (!isObject(row)) throw invalidGitResponse();
        assertExactKeys(
          row,
          ["repository_id", "full_name", "permissions"],
          [],
          "repository assignment",
        );
        return {
          ...gitRepository(row),
          permissions: gitPermissions(row.permissions),
        };
      }),
    };
  }

  setGitAssignment(
    serverId: string,
    repositoryId: number,
    permissions: GitPermissionMap,
    signal?: AbortSignal,
  ): Promise<GitAssignmentResult> {
    return this.changeGitAssignment(
      serverId,
      repositoryId,
      signal,
      permissions,
    );
  }

  removeGitAssignment(
    serverId: string,
    repositoryId: number,
    signal?: AbortSignal,
  ): Promise<GitAssignmentResult> {
    return this.changeGitAssignment(serverId, repositoryId, signal);
  }

  private async changeGitAssignment(
    serverId: string,
    repositoryId: number,
    signal?: AbortSignal,
    permissions?: GitPermissionMap,
  ): Promise<GitAssignmentResult> {
    const id = normalizeUuid(serverId);
    const url = `${API_BASE}servers/${id}/github-repositories/${repositoryId}/`;
    const body = await this.gitRequest(
      permissions ? "POST" : "DELETE",
      url,
      signal,
      permissions ? { permissions } : undefined,
    );
    assertExactKeys(
      body,
      ["server_id", "repository_id", "full_name", "permissions", "code"],
      [],
      "repository assignment result",
    );
    if (body.server_id !== id || body.repository_id !== repositoryId)
      throw invalidGitResponse();
    const effective = gitPermissions(body.permissions);
    if (
      !GIT_PERMISSION_KEYS.every(
        (key) => effective[key] === (permissions?.[key] ?? "none"),
      )
    )
      throw invalidGitResponse();
    const assigned = GIT_PERMISSION_KEYS.some(
      (key) => effective[key] !== "none",
    );
    const code = body.code;
    if (
      assigned
        ? code !== "permissions_set"
        : code !== "removed" && code !== "already_unassigned"
    )
      throw invalidGitResponse();
    return {
      ...gitRepository(body),
      server_id: id,
      permissions: effective,
      code: code as GitAssignmentResult["code"],
    };
  }

  private async gitRequest(
    method: "GET" | "POST" | "DELETE",
    url: string,
    signal?: AbortSignal,
    body?: { permissions: GitPermissionMap },
  ): Promise<Record<string, unknown>> {
    const response = await requestJson(this.fetcher, url, {
      method,
      headers: await this.issuerHeaders(method, url),
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) {
      const error = errorFromResponse(response, "git_permissions_failed");
      if (
        error.code === "repository_unavailable" &&
        isObject(response.body) &&
        isObject(response.body.error) &&
        response.body.error.connect_url === CONNECTED_GITHUB_URL
      ) {
        throw new TeamClawsError(error.code, error.message, {
          exitCode: error.exitCode,
          connectUrl: CONNECTED_GITHUB_URL,
        });
      }
      throw error;
    }
    if (!isObject(response.body)) throw invalidGitResponse();
    return response.body;
  }

  async claimMetadataPrompt(
    serverId: string,
    signal?: AbortSignal,
  ): Promise<{ should_prompt: boolean; server: ServerMetadata }> {
    const id = normalizeUuid(serverId);
    const url = `${API_BASE}servers/${id}/metadata-prompt/claim/`;
    const response = await requestJson(this.fetcher, url, {
      method: "POST",
      headers: await this.issuerHeaders("POST", url),
      body: {},
      ...(signal ? { signal } : {}),
    });
    if (response.status < 200 || response.status >= 300)
      throw errorFromResponse(response, "server_metadata_prompt_failed");
    if (!isObject(response.body)) throw invalidMetadataResponse();
    assertExactKeys(
      response.body,
      ["should_prompt", "server"],
      [],
      "workspace metadata prompt response",
    );
    if (typeof response.body.should_prompt !== "boolean")
      throw invalidMetadataResponse();
    return {
      should_prompt: response.body.should_prompt,
      server: editableServer(response.body.server, id),
    };
  }

  async startPairing(
    target: PairingTarget,
    signal?: AbortSignal,
  ): Promise<PendingPairing> {
    if (!this.authorization)
      throw new TeamClawsError(
        "login_required",
        "CLI authorization is required for pairing.",
        { exitCode: 3 },
      );
    const grant = await this.authorization.requireGrant();
    const request = pairingStartRequest(
      target,
      this.currentDeviceName(),
      grant,
    );
    const url = `${API_BASE}pairing/start/`;
    const response = await requestJson(this.fetcher, url, {
      method: "POST",
      headers: {
        ...requestHeaders(),
        DPoP: await this.authorization.dpop(grant.machine_key, "POST", url),
      },
      body: request,
      ...(signal ? { signal } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      throw errorFromResponse(response, "pairing_start_failed");
    }
    const pending = parsePendingPairing(response.body);
    if (
      "workspace_url" in target &&
      pending.target.origin !== new URL(target.workspace_url).origin
    ) {
      throw new TeamClawsError(
        "target_mismatch",
        "TeamClaws resolved a different workspace than the one requested.",
        { exitCode: 9 },
      );
    }
    return pending;
  }

  private async issuerHeaders(
    method: string,
    url: string,
  ): Promise<Record<string, string>> {
    if (!this.authorization)
      throw new TeamClawsError(
        "login_required",
        "CLI authorization is required.",
        { exitCode: 3 },
      );
    return {
      ...requestHeaders(),
      ...(await this.authorization.accountHeadersFor(method, url)),
    };
  }
}

function invalidGitResponse(): TeamClawsError {
  return new TeamClawsError(
    "invalid_response",
    "TeamClaws returned an invalid Git permissions response.",
    { exitCode: 9 },
  );
}

function gitRepository(value: Record<string, unknown>): GitRepository {
  const fullName = requireString(value.full_name, "repository name");
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(fullName))
    throw invalidGitResponse();
  return {
    repository_id: requireInteger(
      value.repository_id,
      "repository ID",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    full_name: fullName,
  };
}

function gitPermissions(value: unknown): GitPermissionMap {
  if (!isObject(value)) throw invalidGitResponse();
  assertExactKeys(value, GIT_PERMISSION_KEYS, [], "Git permission map");
  const access = (
    key: "issues" | "contents" | "pull_requests",
  ): GitAccessLevel => {
    const level = value[key];
    if (level === "none" || level === "read" || level === "write") return level;
    throw invalidGitResponse();
  };
  const workflows = value.workflows;
  if (workflows !== "none" && workflows !== "write") throw invalidGitResponse();
  return {
    issues: access("issues"),
    contents: access("contents"),
    pull_requests: access("pull_requests"),
    workflows,
  };
}

function invalidEmailResponse(): TeamClawsError {
  return new TeamClawsError(
    "invalid_response",
    "TeamClaws returned an invalid email permissions response.",
    { exitCode: 9 },
  );
}

function emailAccount(row: Record<string, unknown>): EmailAccount {
  if (
    (row.provider !== "google" && row.provider !== "microsoft") ||
    !Number.isSafeInteger(row.account_id) ||
    Number(row.account_id) <= 0
  )
    throw invalidEmailResponse();
  return {
    provider: row.provider,
    account_id: Number(row.account_id),
    email: requireString(row.email, "email account", 254),
  };
}

function emailPolicy(value: unknown): EmailAssignmentPolicy {
  if (
    value !== "read_only" &&
    value !== "write_with_approval_read" &&
    value !== "write_read"
  )
    throw invalidEmailResponse();
  return value;
}

function invalidMetadataResponse(): TeamClawsError {
  return new TeamClawsError(
    "invalid_response",
    "TeamClaws returned invalid workspace metadata.",
    { exitCode: 9 },
  );
}

function editableServer(value: unknown, expectedId: string): ServerMetadata {
  if (!isObject(value)) throw invalidMetadataResponse();
  assertExactKeys(
    value,
    ["id", "alias", "description", "custom_alias", "can_edit_metadata"],
    [],
    "workspace metadata",
  );
  const id = normalizeUuid(value.id);
  if (
    id !== expectedId ||
    value.can_edit_metadata !== true ||
    typeof value.custom_alias !== "string" ||
    [...value.custom_alias].length > 100 ||
    typeof value.description !== "string"
  )
    throw invalidMetadataResponse();
  return {
    server_id: id,
    alias: requireString(value.alias, "workspace alias", 200),
    description: value.description,
    custom_alias: value.custom_alias,
    can_edit_metadata: true,
  };
}

export function pairingStartRequest(
  target: PairingTarget,
  deviceName: string,
  grant: DurableAuthorization,
): Record<string, unknown> {
  return {
    contract_version: CONTRACT_VERSION,
    target,
    request_id: randomUUID(),
    device_name: deviceName,
    client_name: CLIENT_NAME,
    client_version: PACKAGE_VERSION,
    authorization_id: grant.authorization_id,
  };
}

export function normalizedDeviceName(value: string): string {
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DEVICE_NAME_LENGTH);
  return normalized || "Unnamed computer";
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": `${CLIENT_NAME}/${PACKAGE_VERSION}`.slice(
      0,
      MAX_CLIENT_LABEL_LENGTH,
    ),
  };
  return headers;
}
