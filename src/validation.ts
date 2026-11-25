import { isIP } from "node:net";

import { TeamClawsError } from "./errors.js";
import type {
  AgentAction,
  DirectTarget,
  ExternalChatHandoff,
  JsonObject,
  LoginCredential,
  PairingCredential,
  PairingTarget,
  PendingPairing,
  SafeUser,
  ServerSummary,
  StatusWorkspaceCredential,
  VerifiedWorkspace,
  WorkspaceCredential,
} from "./types.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertExactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "response",
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TeamClawsError(
        "invalid_response",
        `TeamClaws returned an invalid ${label}.`,
        { exitCode: 9 },
      );
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new TeamClawsError(
        "invalid_response",
        `TeamClaws returned an incomplete ${label}.`,
        { exitCode: 9 },
      );
    }
  }
}

export function requireString(
  value: unknown,
  label: string,
  maxLength = 2_048,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new TeamClawsError(
      "invalid_response",
      `TeamClaws returned an invalid ${label}.`,
      {
        exitCode: 9,
      },
    );
  }
  return value;
}

export function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new TeamClawsError(
      "invalid_response",
      `TeamClaws returned an invalid ${label}.`,
      {
        exitCode: 9,
      },
    );
  }
  return Number(value);
}

export function normalizeUuid(value: unknown, label = "workspace ID"): string {
  const normalized = requireString(value, label, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new TeamClawsError("invalid_target", `The ${label} is not valid.`, {
      exitCode: 2,
    });
  }
  return normalized;
}

export function canonicalWorkspaceUrl(value: unknown): string {
  return `${canonicalWorkspaceOrigin(value)}/`;
}

export function canonicalWorkspaceOrigin(value: unknown): string {
  const raw = requireString(value, "workspace address", 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TeamClawsError(
      "invalid_target",
      "The workspace address is not valid.",
      {
        exitCode: 2,
      },
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.hostname === "localhost" ||
    isIP(url.hostname) !== 0
  ) {
    throw new TeamClawsError(
      "invalid_target",
      "Use a canonical HTTPS TeamClaws workspace address.",
      { exitCode: 2 },
    );
  }
  return url.origin;
}

export function parsePairingTarget(value: string): PairingTarget {
  if (UUID_PATTERN.test(value)) return { server_id: value.toLowerCase() };
  try {
    return { workspace_url: canonicalWorkspaceUrl(value) };
  } catch (error) {
    if (!(error instanceof TeamClawsError) || error.code !== "invalid_target")
      throw error;
    throw new TeamClawsError(
      "invalid_target",
      "Use the workspace ID from teamclaws workspaces list or the full HTTPS workspace URL.",
      { exitCode: 2 },
    );
  }
}

export function validateDirectTarget(value: unknown): DirectTarget {
  if (!isObject(value)) {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned an invalid target.",
      {
        exitCode: 9,
      },
    );
  }
  assertExactKeys(
    value,
    [
      "origin",
      "token_poll_path",
      "cancellation_path",
      "credential_verification_path",
    ],
    [],
    "target",
  );
  const origin = canonicalWorkspaceOrigin(value.origin);
  const target = {
    origin,
    token_poll_path: validateRelativeTargetPath(value.token_poll_path, origin),
    cancellation_path: validateRelativeTargetPath(
      value.cancellation_path,
      origin,
    ),
    credential_verification_path: validateRelativeTargetPath(
      value.credential_verification_path,
      origin,
    ),
  };
  return target;
}

export function validateRelativeTargetPath(
  value: unknown,
  origin: string,
): string {
  const path = requireString(value, "target path", 2_048);
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new TeamClawsError(
      "unsafe_target",
      "TeamClaws returned an unsafe target path.",
      {
        exitCode: 9,
      },
    );
  }
  const resolved = new URL(path, origin);
  if (resolved.origin !== origin || resolved.pathname !== path) {
    throw new TeamClawsError(
      "unsafe_target",
      "TeamClaws returned an unsafe target path.",
      {
        exitCode: 9,
      },
    );
  }
  return path;
}

export function directTargetUrl(target: DirectTarget, path: string): string {
  return new URL(path, `${target.origin}/`).toString();
}

export function parsePendingPairing(value: unknown): PendingPairing {
  if (!isObject(value)) {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned an invalid pairing response.",
      {
        exitCode: 9,
      },
    );
  }
  assertExactKeys(
    value,
    [
      "contract_version",
      "server_id",
      "target",
      "user_code",
      "verification_uri_complete",
      "expires_in",
      "interval",
      "status",
      "device_code",
    ],
    ["agent_action"],
    "pairing response",
  );
  if (value.contract_version !== 1 || value.status !== "pending") {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned an unsupported pairing response.",
      {
        exitCode: 9,
      },
    );
  }
  const target = validateDirectTarget(value.target);
  const verificationText = requireString(
    value.verification_uri_complete,
    "approval address",
    2_048,
  );
  const verification = requireHttpsUrl(verificationText, "approval address");
  if (verification.origin !== target.origin) {
    throw new TeamClawsError(
      "unsafe_target",
      "The pairing approval address does not match the selected workspace.",
      { exitCode: 9 },
    );
  }
  const userCode = requireString(value.user_code, "user code", 64);
  const deviceCode = requireString(value.device_code, "device code", 4_096);
  const pending: PendingPairing = {
    contract_version: 1,
    server_id: normalizeUuid(value.server_id),
    target,
    user_code: userCode,
    verification_uri_complete: verificationText,
    expires_in: requireInteger(value.expires_in, "pairing expiry", 1, 1_800),
    interval: requireInteger(value.interval, "polling interval", 1, 60),
    status: "pending",
    device_code: deviceCode,
  };
  if ("agent_action" in value) {
    pending.agent_action = parseAgentAction(
      value.agent_action,
      verificationText,
      userCode,
      deviceCode,
    );
  }
  return pending;
}

export function parseAgentAction(
  value: unknown,
  verificationUri: string,
  userCode: string,
  deviceCode: string,
): AgentAction {
  if (!isObject(value)) {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned an invalid agent action.",
      { exitCode: 9 },
    );
  }
  assertExactKeys(
    value,
    [
      "schema_version",
      "type",
      "message_format",
      "message_markdown",
      "expires_at",
    ],
    [],
    "agent action",
  );
  const message = requireString(
    value.message_markdown,
    "agent action message",
    8_192,
  );
  if (
    value.schema_version !== 1 ||
    value.type !== "deliver_and_stop" ||
    value.message_format !== "markdown" ||
    !message.includes(verificationUri) ||
    !message.includes(userCode) ||
    message.includes(deviceCode)
  ) {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned an unsafe agent action.",
      { exitCode: 9 },
    );
  }
  return {
    schema_version: 1,
    type: "deliver_and_stop",
    message_format: "markdown",
    message_markdown: message,
    expires_at: requireIsoDate(value.expires_at, "agent action expiry"),
  };
}

export function requireHttpsUrl(value: unknown, label: string): URL {
  const raw = requireString(value, label, 4_096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TeamClawsError(
      "invalid_response",
      `TeamClaws returned an invalid ${label}.`,
      {
        exitCode: 9,
      },
    );
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TeamClawsError(
      "invalid_response",
      `TeamClaws returned an unsafe ${label}.`,
      {
        exitCode: 9,
      },
    );
  }
  return url;
}

export function parsePairingCredential(value: unknown): PairingCredential {
  if (!isObject(value) || value.status !== "paired") {
    throw new TeamClawsError(
      "invalid_response",
      "The workspace returned an invalid credential.",
      {
        exitCode: 9,
      },
    );
  }
  if (value.token_type !== "Bearer") {
    throw new TeamClawsError(
      "invalid_response",
      "The workspace returned an unsupported credential.",
      {
        exitCode: 9,
      },
    );
  }
  return {
    device_id: normalizeUuid(value.device_id, "device identifier"),
    device_token: requireString(value.device_token, "device token", 8_192),
    pairing_id: normalizeUuid(value.pairing_id, "pairing identifier"),
    server_id: normalizeUuid(value.server_id, "workspace ID"),
    origin: canonicalWorkspaceOrigin(value.origin),
    requester_sub: requireString(value.requester_sub, "requester subject", 255),
    authorization_id: normalizeUuid(
      value.authorization_id,
      "authorization identifier",
    ),
    machine_jkt: requireThumbprint(value.machine_jkt),
    ...(Object.hasOwn(value, "external_chat_capabilities")
      ? {
          external_chat_capabilities: value.external_chat_capabilities,
          external_chat_capabilities_generated_at:
            value.external_chat_capabilities_generated_at,
        }
      : {}),
  };
}

export function parseVerifiedDevice(
  value: unknown,
  expectedDeviceId: string,
): string {
  if (!isObject(value) || !isObject(value.paired_device)) {
    throw new TeamClawsError(
      "credential_verification_failed",
      "The workspace credential was not verified.",
      {
        exitCode: 9,
      },
    );
  }
  const id = normalizeUuid(value.paired_device.id, "device identifier");
  if (id !== expectedDeviceId || value.paired_device.status !== "active") {
    throw new TeamClawsError(
      "credential_verification_failed",
      "The workspace credential was not verified.",
      {
        exitCode: 9,
      },
    );
  }
  return requireString(
    value.paired_device.display_name,
    "workspace device name",
    120,
  );
}

export function parseVerifiedWorkspace(
  value: unknown,
  expectedDeviceId: string,
  origin: string,
): VerifiedWorkspace {
  if (!isObject(value)) {
    throw new TeamClawsError(
      "credential_verification_failed",
      "The workspace credential was not verified.",
      { exitCode: 9 },
    );
  }
  return {
    display_name: parseVerifiedDevice(value, expectedDeviceId),
    external_chat_handoff: parseExternalChatHandoff(
      value.external_chat_handoff,
      origin,
    ),
  };
}

export function parseExternalChatHandoff(
  value: unknown,
  origin: string,
): ExternalChatHandoff {
  if (
    !isObject(value) ||
    value.schema_version !== 1 ||
    value.contract_version !== 1
  ) {
    throw invalidExternalChatHandoff();
  }
  const reasonCodes = parseReasonCodes(value.reason_codes);
  if (
    value.status === "re_pair_required" &&
    value.recommended_action === "re_pair" &&
    reasonCodes.length > 0
  ) {
    return {
      schema_version: 1,
      contract_version: 1,
      status: "re_pair_required",
      reason_codes: reasonCodes,
      recommended_action: "re_pair",
    };
  }
  if (
    value.status === "unavailable" &&
    value.recommended_action === "retry_later" &&
    reasonCodes.includes("client_bundle_unavailable")
  ) {
    return {
      schema_version: 1,
      contract_version: 1,
      status: "unavailable",
      reason_codes: reasonCodes,
      recommended_action: "retry_later",
    };
  }
  const skillUrl = `${origin}/teamclaws-admin/device-chat-client/SKILL.md`;
  const bundleSha256 = requireString(
    value.bundle_sha256,
    "external chat bundle digest",
    64,
  );
  if (
    value.status !== "ready" ||
    value.recommended_action !== "load_skill" ||
    reasonCodes.length !== 0 ||
    value.skill_name !== "teamclaws-external-chat-client" ||
    value.skill_url !== skillUrl ||
    value.capabilities_url !==
      "/teamclaws-admin/api/device-chat/v1/capabilities/" ||
    !/^[0-9a-f]{64}$/u.test(bundleSha256)
  ) {
    throw invalidExternalChatHandoff();
  }
  return {
    schema_version: 1,
    contract_version: 1,
    status: "ready",
    reason_codes: [],
    skill_url: skillUrl,
    skill_name: "teamclaws-external-chat-client",
    bundle_sha256: bundleSha256,
    capabilities_url: "/teamclaws-admin/api/device-chat/v1/capabilities/",
    recommended_action: "load_skill",
  };
}

export function parseSafeUserResponse(value: unknown): SafeUser {
  if (!isObject(value)) {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned an invalid account response.",
      {
        exitCode: 9,
      },
    );
  }
  assertExactKeys(
    value,
    ["id", "email", "display_name", "authorization_id", "authorization_status"],
    [],
    "account response",
  );
  if (value.authorization_status !== "active") {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned an invalid account response.",
      {
        exitCode: 9,
      },
    );
  }
  normalizeUuid(value.authorization_id, "authorization identifier");
  return {
    id: normalizeUuid(value.id, "user identifier"),
    display_name: requireString(value.display_name, "display name", 200),
    email: requireString(value.email, "email", 320),
  };
}

export function parseServersResponse(value: unknown): ServerSummary[] {
  if (!isObject(value)) {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned an invalid workspace list.",
      {
        exitCode: 9,
      },
    );
  }
  if (!Array.isArray(value.servers)) {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned an invalid workspace list.",
      {
        exitCode: 9,
      },
    );
  }
  if (value.servers.length > 1_000) {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned too many servers.",
      {
        exitCode: 9,
      },
    );
  }
  return value.servers.map((server) => {
    if (!isObject(server)) {
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned an invalid server.",
        {
          exitCode: 9,
        },
      );
    }
    if (typeof server.pairing_ready !== "boolean") {
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned an invalid server.",
        {
          exitCode: 9,
        },
      );
    }
    if (
      server.description !== undefined &&
      typeof server.description !== "string"
    ) {
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned an invalid workspace description.",
        { exitCode: 9 },
      );
    }
    if (
      (server.custom_alias !== undefined &&
        (typeof server.custom_alias !== "string" ||
          [...server.custom_alias].length > 100)) ||
      (server.can_edit_metadata !== undefined &&
        typeof server.can_edit_metadata !== "boolean")
    ) {
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned invalid workspace editing permissions.",
        { exitCode: 9 },
      );
    }
    if (
      server.is_free !== undefined &&
      server.is_free !== null &&
      typeof server.is_free !== "boolean"
    ) {
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned an invalid free subscription status.",
        { exitCode: 9 },
      );
    }
    return {
      server_id: normalizeUuid(server.id),
      ...(server.workspace_state !== undefined
        ? {
            workspace_state:
              server.workspace_state === "building" ||
              server.workspace_state === "running" ||
              server.workspace_state === "powered_off" ||
              server.workspace_state === "error"
                ? server.workspace_state
                : null,
          }
        : {}),
      ...(server.status_since !== undefined
        ? {
            status_since:
              server.status_since === null
                ? null
                : requireIsoDate(
                    server.status_since,
                    "workspace status start time",
                  ),
          }
        : {}),
      ...(server.created_at !== undefined
        ? {
            created_at: requireIsoDate(
              server.created_at,
              "workspace creation time",
            ),
          }
        : {}),
      ...(server.deployment_status !== undefined
        ? {
            deployment_status:
              server.deployment_status === null
                ? null
                : requireString(
                    server.deployment_status,
                    "deployment status",
                    50,
                  ),
          }
        : {}),
      ...(server.tier_name !== undefined
        ? {
            tier_name:
              server.tier_name === null
                ? null
                : requireString(server.tier_name, "subscription tier", 200),
          }
        : {}),
      ...(server.is_free !== undefined ? { is_free: server.is_free } : {}),
      ...(server.free_expires_at !== undefined
        ? {
            free_expires_at:
              server.free_expires_at === null
                ? null
                : requireIsoDate(
                    server.free_expires_at,
                    "free subscription expiry",
                  ),
          }
        : {}),
      alias: requireString(server.alias, "workspace alias", 200),
      ...(typeof server.description === "string"
        ? { description: server.description }
        : {}),
      ...(server.resources !== undefined
        ? {
            resources: (() => {
              if (!Array.isArray(server.resources))
                throw new TeamClawsError(
                  "invalid_response",
                  "TeamClaws returned invalid workspace resources.",
                  { exitCode: 9 },
                );
              return server.resources.map((resource) => {
                if (
                  !isObject(resource) ||
                  !Array.isArray(resource.skills) ||
                  (resource.permissions !== undefined &&
                    !isObject(resource.permissions))
                )
                  throw new TeamClawsError(
                    "invalid_response",
                    "TeamClaws returned an invalid workspace resource.",
                    { exitCode: 9 },
                  );
                return {
                  type: requireString(resource.type, "resource type", 150),
                  name: requireString(resource.name, "resource name", 512),
                  ...(resource.permissions !== undefined
                    ? {
                        permissions: Object.fromEntries(
                          Object.entries(resource.permissions).map(
                            ([key, value]) => [
                              requireString(key, "resource permission", 150),
                              requireString(
                                value,
                                "resource permission level",
                                150,
                              ),
                            ],
                          ),
                        ),
                      }
                    : {}),
                  skills: resource.skills.map((skill) =>
                    requireString(skill, "resource skill", 150),
                  ),
                };
              });
            })(),
          }
        : {}),
      ...(typeof server.custom_alias === "string"
        ? { custom_alias: server.custom_alias }
        : {}),
      ...(typeof server.can_edit_metadata === "boolean"
        ? { can_edit_metadata: server.can_edit_metadata }
        : {}),
      workspace_url: canonicalWorkspaceUrl(server.workspace_url),
      status: requireString(server.status, "workspace status", 40),
      pairing_ready: server.pairing_ready,
      version:
        typeof server.version === "string" && server.version
          ? server.version
          : null,
      available_version:
        typeof server.available_version === "string" && server.available_version
          ? server.available_version
          : null,
      update_available:
        typeof server.update_available === "boolean"
          ? server.update_available
          : null,
    };
  });
}

export function parseLoginCredential(value: unknown): LoginCredential {
  if (!isObject(value)) throw invalidCredentialFile();
  assertExactKeys(
    value,
    ["version", "token_type", "access_token", "refresh_token", "expires_at"],
    [],
    "login credential file",
  );
  if (value.version !== 1 || value.token_type !== "Bearer")
    throw invalidCredentialFile();
  return {
    version: 1,
    token_type: "Bearer",
    access_token: requireSecret(value.access_token),
    refresh_token: requireSecret(value.refresh_token),
    expires_at: requireIsoDate(value.expires_at, "login credential expiry"),
  };
}

export function parseWorkspaceCredential(value: unknown): WorkspaceCredential {
  if (!isObject(value)) throw invalidCredentialFile();
  if (value.version === 1) throw legacyPairingError();
  assertExactKeys(
    value,
    [
      "version",
      "server_id",
      "origin",
      "display_name",
      "device_id",
      "pairing_id",
      "device_token",
      "requester_sub",
      "authorization_id",
      "machine_jkt",
      "created_at",
    ],
    [],
    "workspace credential file",
  );
  if (value.version !== 2) throw invalidCredentialFile();
  return {
    version: 2,
    server_id: normalizeUuid(value.server_id),
    origin: canonicalWorkspaceOrigin(value.origin),
    display_name: requireString(value.display_name, "display name", 120),
    device_id: normalizeUuid(value.device_id, "device identifier"),
    pairing_id: normalizeUuid(value.pairing_id, "pairing identifier"),
    device_token: requireSecret(value.device_token),
    requester_sub: requireString(value.requester_sub, "requester subject", 255),
    authorization_id: normalizeUuid(
      value.authorization_id,
      "authorization identifier",
    ),
    machine_jkt: requireThumbprint(value.machine_jkt),
    created_at: requireIsoDate(value.created_at, "credential creation date"),
  };
}

export function parseStatusWorkspaceCredential(
  value: unknown,
  expectedServerId: string,
): StatusWorkspaceCredential {
  if (!isObject(value)) throw invalidCredentialFile();
  if (value.version === 1) throw legacyPairingError();
  if (value.version !== 2) throw invalidCredentialFile();
  const serverId = normalizeUuid(value.server_id);
  if (serverId !== normalizeUuid(expectedServerId))
    throw invalidCredentialFile();
  return {
    version: 2,
    server_id: serverId,
    origin: canonicalWorkspaceOrigin(value.origin),
    display_name:
      typeof value.display_name === "string" && value.display_name.length > 0
        ? requireString(value.display_name, "display name", 120)
        : "Paired device",
    device_id: normalizeUuid(value.device_id, "device identifier"),
    pairing_id: normalizeUuid(value.pairing_id, "pairing identifier"),
    device_token: requireSecret(value.device_token),
    requester_sub: requireString(value.requester_sub, "requester subject", 255),
    authorization_id: normalizeUuid(
      value.authorization_id,
      "authorization identifier",
    ),
    machine_jkt: requireThumbprint(value.machine_jkt),
  };
}

function requireThumbprint(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw invalidCredentialFile();
  return value;
}

function legacyPairingError(): TeamClawsError {
  return new TeamClawsError(
    "re_pair_required",
    "This saved pairing predates bound CLI authorization. Pair this workspace again.",
    { exitCode: 3 },
  );
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 8_192) {
    throw invalidCredentialFile();
  }
  return value;
}

function parseReasonCodes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > 64 ||
        !/^[a-z0-9_]+$/u.test(item),
    )
  ) {
    throw invalidExternalChatHandoff();
  }
  return [...new Set(value)].sort();
}

function invalidExternalChatHandoff(): TeamClawsError {
  return new TeamClawsError(
    "invalid_external_chat_handoff",
    "The workspace returned an unsupported external chat handoff.",
    { exitCode: 9 },
  );
}

function requireIsoDate(value: unknown, label: string): string {
  const text = requireString(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) {
    throw new TeamClawsError(
      "invalid_response",
      `TeamClaws returned an invalid ${label}.`,
      {
        exitCode: 9,
      },
    );
  }
  return text;
}

function invalidCredentialFile(): TeamClawsError {
  return new TeamClawsError(
    "invalid_credential_file",
    "The local TeamClaws credential file is invalid.",
    { exitCode: 9 },
  );
}

export function parseWorkspaceInventory(value: unknown): {
  servers: ServerSummary[];
  workspace_count?: number;
} {
  const servers = parseServersResponse(value);
  if (!isObject(value) || value.workspace_count === undefined)
    return { servers };
  return {
    servers,
    workspace_count: requireInteger(
      value.workspace_count,
      "workspace count",
      servers.length,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}
