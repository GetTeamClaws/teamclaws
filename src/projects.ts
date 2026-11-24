import type { BrokerClient } from "./broker.js";
import { TeamClawsError } from "./errors.js";
import { type FetchLike, errorFromResponse, requestJson } from "./http.js";
import {
  requestTargetJson,
  type TargetAuthorization,
} from "./target-authorization.js";
import type { CredentialStore } from "./storage.js";
import type { PairingTarget, ServerSummary } from "./types.js";
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
  broker: BrokerClient,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const credential = await store.findWorkspace(target);
  let accountServer: ServerSummary | undefined;
  if (!credential) {
    const inventory = await broker.servers(signal);
    const matches = inventory.servers.filter((server) =>
      "server_id" in target
        ? server.server_id === target.server_id
        : new URL(server.workspace_url).origin ===
          new URL(target.workspace_url).origin,
    );
    if (matches.length !== 1)
      throw new TeamClawsError(
        "target_unavailable",
        "The selected workspace is not available to this TeamClaws account.",
        { exitCode: 3 },
      );
    accountServer = matches[0]!;
  }
  let response;
  try {
    if (credential) {
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
    } else {
      const server = accountServer!;
      const url = `${new URL(server.workspace_url).origin}/teamclaws-admin/api/projects/`;
      const method = data.action === "list" ? "GET" : "POST";
      response = await requestJson(fetcher, url, {
        method,
        headers: await authorization.headersForAccountShell(
          method,
          url,
          server,
          signal,
        ),
        ...(data.action === "list" ? {} : { body: data }),
        ...(signal ? { signal } : {}),
      });
    }
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
