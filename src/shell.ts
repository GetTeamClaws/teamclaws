import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import { TeamClawsError } from "./errors.js";
import type { BrokerClient } from "./broker.js";
import { errorFromResponse, requestJson, type FetchLike } from "./http.js";
import { requestTargetJson } from "./target-authorization.js";
import type { CredentialStore } from "./storage.js";
import type { PairingTarget } from "./types.js";
import type { TargetAuthorization } from "./target-authorization.js";
import { isObject } from "./validation.js";

export type ShellResult = { stdout: string; stderr: string; exit_code: number };

export async function runShell(
  store: CredentialStore,
  fetcher: FetchLike,
  target: PairingTarget,
  command: string,
  authorization: TargetAuthorization,
  broker: BrokerClient,
  signal?: AbortSignal,
): Promise<ShellResult> {
  const credential = await store.findWorkspace(target);
  const options = {
    method: "POST" as const,
    textBody: command,
    timeoutMs: null,
    responseLimitBytes: null,
    ...(signal ? { signal } : {}),
  };
  let response;
  if (credential) {
    const url = `${credential.origin}/teamclaws-admin/api/shell/`;
    response = await requestTargetJson(
      fetcher,
      authorization,
      url,
      credential,
      options,
    );
  } else {
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
    const server = matches[0]!;
    const url = `${new URL(server.workspace_url).origin}/teamclaws-admin/api/shell/`;
    response = await requestJson(fetcher, url, {
      ...options,
      headers: await authorization.headersForAccountShell(
        "POST",
        url,
        server,
        signal,
      ),
    });
  }
  if (response.status !== 200)
    throw errorFromResponse(response, "shell_failed");
  const result = response.body;
  if (
    !isObject(result) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    !Number.isSafeInteger(result.exit_code)
  ) {
    throw new TeamClawsError("invalid_response", "Invalid shell result.", {
      exitCode: 9,
    });
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exit_code as number,
  };
}

// Native fetch imposes transport deadlines. This single-use connection has no
// request deadline, redirects, retries, or response body limit.
export const shellFetch: FetchLike = async (input, init) => {
  const url = new URL(String(input));
  return await new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)),
        agent: false,
        timeout: 0,
        ...(init?.signal ? { signal: init.signal } : {}),
      },
      (response) => {
        const status = response.statusCode ?? 500;
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          headers.append(
            response.rawHeaders[index]!,
            response.rawHeaders[index + 1]!,
          );
        }
        if (status >= 300 && status < 400) {
          response.resume();
          reject(new Error("Shell redirects are not followed."));
          return;
        }
        const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        if (status === 204 || status === 205 || status === 304)
          response.resume();
        resolve(
          new Response(
            status === 204 || status === 205 || status === 304 ? null : body,
            { status, headers },
          ),
        );
      },
    );
    request.on("error", reject);
    request.end(init?.body);
  });
};
