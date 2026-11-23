import { TeamClawsError } from "./errors.js";
import { type FetchLike, errorFromResponse } from "./http.js";
import {
  requestTargetJson,
  type TargetAuthorization,
} from "./target-authorization.js";
import type { CredentialStore } from "./storage.js";
import type { PairingTarget } from "./types.js";
import { isObject } from "./validation.js";

export type ProjectRequest = {
  action: "list" | "create" | "rename" | "delete" | "hide" | "show";
  request_id?: string;
  project_id?: number;
  path?: string;
  name?: string;
  create_directory?: boolean;
  delete_directory?: boolean;
};

export async function runProjects(
  store: CredentialStore,
  fetcher: FetchLike,
  target: PairingTarget,
  data: ProjectRequest,
  authorization: TargetAuthorization,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const credential = await store.findWorkspace(target);
  if (!credential)
    throw new TeamClawsError(
      "re_pair_required",
      "No saved pairing was found for this workspace. Pair it first.",
      { exitCode: 3 },
    );
  let response;
  try {
    response = await requestTargetJson(
      fetcher,
      authorization,
      `${credential.origin}/teamclaws-admin/api/projects/`,
      credential,
      {
        method: data.action === "list" ? "GET" : "POST",
        ...(data.action === "list" ? {} : { body: data }),
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    if (data.action === "list") throw error;
    return {
      ok: false,
      code: "outcome_unverified",
      request_id: data.request_id,
      detail:
        "Retry only the identical request with the same request ID; do not start another mutation.",
    };
  }
  if (!isObject(response.body))
    throw new TeamClawsError(
      "outcome_unverified",
      "Project outcome could not be verified. Retry the identical request with the same request ID.",
      { exitCode: 1 },
    );
  if (response.body.ok === false) return response.body;
  if (response.status !== 200)
    throw errorFromResponse(response, "project_operation_failed");
  if (response.body.ok !== true)
    throw new TeamClawsError(
      "outcome_unverified",
      "Project outcome could not be verified. Retry the identical request with the same request ID.",
      { exitCode: 1 },
    );
  return response.body;
}
