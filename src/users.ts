import { TeamClawsError } from "./errors.js";
import type { FetchLike, JsonResponse } from "./http.js";
import type { CredentialStore } from "./storage.js";
import {
  requestTargetJson,
  type TargetAuthorization,
} from "./target-authorization.js";
import type {
  MachineUserRole,
  PairingTarget,
  UsersAddResult,
  UsersListResult,
} from "./types.js";
import { isObject } from "./validation.js";

const failureMessages: Record<string, string> = {
  invalid_actor_token:
    "The machine authorization is invalid, expired, paused, or revoked.",
  unauthorized: "The workspace rejected the paired machine credential.",
  target_proof_expired: "The request proof expired before user addition.",
  forbidden: "The paired identity is not authorized to add users.",
  owner_required: "Only the current machine owner can add users.",
  actor_machine_mismatch:
    "The authorization does not match this machine or its paired identity.",
  actor_authorization_unavailable:
    "Machine authorization could not be verified. Try again later.",
  authorization_unavailable:
    "Machine authorization could not be verified. Try again later.",
  machine_auth_failed: "The workspace's machine authentication was rejected.",
  machine_ip_rejected: "The workspace's machine address was rejected.",
  mfa_required:
    "The owner must meet the existing MFA policy before adding users.",
  invalid_email: "Enter a valid email address.",
  invalid_role: "Choose user, staff, or superuser access.",
  invalid_request: "The workspace rejected the add-user request.",
  invite_delivery_failed:
    "The invitation could not be delivered. Check its status before retrying.",
  outcome_unverified:
    "The invitation outcome could not be verified. Check its status before retrying.",
};

export async function runUsersList(
  store: CredentialStore,
  fetcher: FetchLike,
  target: PairingTarget,
  authorization: TargetAuthorization,
  signal?: AbortSignal,
): Promise<UsersListResult> {
  const credential = await store.findWorkspace(target);
  if (!credential)
    throw new TeamClawsError(
      "re_pair_required",
      "No saved pairing was found for this workspace. Pair it first.",
      { exitCode: 3 },
    );
  const response = await requestTargetJson(
    fetcher,
    authorization,
    `${credential.origin}/teamclaws-admin/api/device-users/v1/list/`,
    credential,
    { ...(signal ? { signal } : {}) },
  );
  const body = response.body;
  if (response.status !== 200 || (isObject(body) && body.ok === false)) {
    const messages: Record<string, string> = {
      invalid_actor_token: failureMessages.invalid_actor_token!,
      unauthorized: failureMessages.unauthorized!,
      owner_required:
        "Only the current machine owner can inspect users and invitations.",
      forbidden:
        "The paired identity is not authorized to inspect users and invitations.",
      actor_machine_mismatch: failureMessages.actor_machine_mismatch!,
      actor_authorization_unavailable:
        failureMessages.actor_authorization_unavailable!,
      authorization_unavailable: failureMessages.authorization_unavailable!,
      machine_auth_failed: failureMessages.machine_auth_failed!,
      machine_ip_rejected: failureMessages.machine_ip_rejected!,
    };
    const rawCode = isObject(body) ? body.code : undefined;
    const code =
      typeof rawCode === "string" && Object.hasOwn(messages, rawCode)
        ? rawCode
        : [404, 405].includes(response.status)
          ? "users_list_unavailable"
          : "users_list_failed";
    throw new TeamClawsError(
      code,
      messages[code] ??
        (code === "users_list_unavailable"
          ? "User and invitation status inspection is unavailable on this workspace."
          : "The workspace could not retrieve user and invitation status. Retry the read request."),
      {
        exitCode: response.status === 401 ? 3 : response.status === 429 ? 5 : 1,
      },
    );
  }
  const invalid = (): TeamClawsError =>
    new TeamClawsError(
      "invalid_response",
      "The workspace returned invalid user or invitation status.",
      { exitCode: 9 },
    );
  if (
    !isObject(body) ||
    body.ok !== true ||
    body.action !== "list" ||
    body.scope !== "access_group" ||
    !Array.isArray(body.members) ||
    !Array.isArray(body.invites)
  )
    throw invalid();
  const validEmail = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 254 &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    );
  const roles = ["user", "staff", "superuser"];
  const members = body.members.map((row: unknown) => {
    if (
      !isObject(row) ||
      !validEmail(row.email) ||
      !roles.includes(String(row.role)) ||
      typeof row.is_owner !== "boolean"
    )
      throw invalid();
    return {
      email: row.email,
      role: row.role as MachineUserRole,
      is_owner: row.is_owner,
    };
  });
  const invites = body.invites.map((row: unknown) => {
    if (
      !isObject(row) ||
      !validEmail(row.email) ||
      !roles.includes(String(row.role)) ||
      !["pending", "accepted"].includes(String(row.status)) ||
      typeof row.is_expired !== "boolean"
    )
      throw invalid();
    return {
      email: row.email,
      role: row.role as MachineUserRole,
      status: row.status as "pending" | "accepted",
      is_expired: row.is_expired,
    };
  });
  return { ok: true, action: "list", scope: "access_group", members, invites };
}

export async function runUsersAdd(
  store: CredentialStore,
  fetcher: FetchLike,
  target: PairingTarget,
  email: string,
  role: MachineUserRole,
  authorization: TargetAuthorization,
  signal?: AbortSignal,
): Promise<UsersAddResult> {
  const credential = await store.findWorkspace(target);
  if (!credential)
    throw new TeamClawsError(
      "re_pair_required",
      "No saved pairing was found for this workspace. Pair it first.",
      { exitCode: 3 },
    );

  let response: JsonResponse;
  try {
    response = await requestTargetJson(
      fetcher,
      authorization,
      `${credential.origin}/teamclaws-admin/api/device-users/v1/add/`,
      credential,
      {
        method: "POST",
        body: { email, role },
        timeoutMs: 60_000,
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    if (
      error instanceof TeamClawsError &&
      ["network_error", "network_timeout"].includes(error.code)
    )
      throw new TeamClawsError(
        "outcome_unverified",
        failureMessages.outcome_unverified!,
      );
    throw error;
  }

  const body = response.body;
  if (
    response.status < 200 ||
    response.status >= 300 ||
    (isObject(body) && body.ok === false)
  ) {
    const rawCode = isObject(body)
      ? (body.code ?? (isObject(body.error) ? body.error.code : body.error))
      : undefined;
    const code =
      typeof rawCode === "string" && Object.hasOwn(failureMessages, rawCode)
        ? rawCode
        : response.status === 404 || response.status === 405
          ? "users_add_unavailable"
          : "outcome_unverified";
    throw new TeamClawsError(
      code,
      failureMessages[code] ??
        (code === "users_add_unavailable"
          ? "Direct user addition is unavailable on this workspace."
          : "The workspace could not verify the add-user result."),
      {
        exitCode: response.status === 401 ? 3 : response.status === 429 ? 5 : 1,
      },
    );
  }

  if (
    !isObject(body) ||
    body.ok !== true ||
    body.action !== "add" ||
    body.scope !== "access_group" ||
    body.email !== email ||
    body.requested_role !== role ||
    !(
      (response.status === 201 && body.code === "invited") ||
      (response.status === 200 &&
        ["already_pending", "already_member", "already_owner"].includes(
          String(body.code),
        ))
    )
  )
    throw new TeamClawsError(
      "invalid_response",
      "The workspace returned an invalid add-user result. Check the invitation status before retrying.",
      { exitCode: 9 },
    );

  return {
    ok: true,
    code: body.code as UsersAddResult["code"],
    action: "add",
    scope: "access_group",
    email,
    requested_role: role,
  };
}
