import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { safeError, TeamClawsError } from "./errors.js";
import { errorFromResponse, type FetchLike } from "./http.js";
import type { CredentialStore } from "./storage.js";
import {
  requestTargetJson,
  type TargetAuthorization,
} from "./target-authorization.js";
import type { PairingTarget } from "./types.js";
import { isObject } from "./validation.js";

const runPrefix = "clawgate-release-update-";
const actualRunId = /^clawgate-release-update-[0-9]{14}-[0-9a-f]{8}$/;
const requestAlias =
  /^clawgate-release-update-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type UpgradeOperation =
  { kind: "start"; noWait: boolean } | { kind: "status"; runId?: string };

type UpgradeRun = {
  run_id: string;
  request_id: string | null;
  status: "running" | "succeeded" | "failed";
  phase: string | null;
  detail: string | null;
  release_version: string | null;
  release_sha: string | null;
  rollback_succeeded: boolean | null;
  ready: boolean;
};

type Outcome =
  | "accepted"
  | "running"
  | "ready"
  | "readiness_unverified"
  | "failed"
  | "rolled_back"
  | "temporarily_unreachable"
  | "unavailable"
  | "rejected"
  | "unknown"
  | "interrupted";

export type UpgradeResult = {
  outcome: Outcome;
  workspace_url: string;
  status_command: string;
  run_id: string | null;
  run: UpgradeRun | null;
  error?: { code: string; message: string };
};

export function isUpgradeRunId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (actualRunId.test(value) || requestAlias.test(value))
  );
}

export async function runClawgateUpgrade(
  store: CredentialStore,
  fetcher: FetchLike,
  authorization: TargetAuthorization,
  target: PairingTarget,
  operation: UpgradeOperation,
  progress: (message: string) => void,
  signal?: AbortSignal,
): Promise<UpgradeResult> {
  const grant = await authorization.requireGrant();
  const credential = await store.findWorkspace(target);
  if (!credential)
    throw new TeamClawsError(
      "pairing_required",
      "Pair this TeamClaws workspace before requesting an upgrade.",
      { exitCode: 3 },
    );
  authorization.assertPairing(grant, credential);

  const endpoint = `${credential.origin}/teamclaws-admin/api/clawgate-upgrade/`;
  const requestId = operation.kind === "status" ? undefined : randomUUID();
  let runId =
    operation.kind === "status" ? operation.runId : `${runPrefix}${requestId}`;
  let run: UpgradeRun | null = null;
  let dispatchedStart = false;
  const requestFetcher: FetchLike = async (input, init) => {
    if (init?.method === "POST") dispatchedStart = true;
    const response = await fetcher(input, init);
    if (response.status >= 400) {
      // During a restart, the proxy can return an HTML error page.
      const contentType = response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim();
      if (contentType !== "application/json") {
        await response.body?.cancel();
        return new Response("{}", {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return response;
  };
  const result = (outcome: Outcome, error?: unknown): UpgradeResult => {
    const failure = error === undefined ? undefined : safeError(error);
    return {
      outcome,
      workspace_url: `${credential.origin}/teamclaws-admin/`,
      status_command: `teamclaws servers upgrade status ${credential.server_id}${runId ? ` --run-id ${runId}` : ""}`,
      run_id: runId ?? null,
      run,
      ...(failure
        ? { error: { code: failure.code, message: failure.message } }
        : {}),
    };
  };
  const request = async (method: "GET" | "POST"): Promise<UpgradeRun> => {
    const url = new URL(endpoint);
    if (method === "GET" && runId) url.searchParams.set("run_id", runId);
    const response = await requestTargetJson(
      requestFetcher,
      authorization,
      url.toString(),
      credential,
      {
        method,
        ...(method === "POST" ? { body: { request_id: requestId } } : {}),
        timeoutMs: null,
        ...(signal ? { signal } : {}),
      },
    );
    if (response.status >= 500 || response.status === 429)
      throw new TeamClawsError(
        "upgrade_temporarily_unreachable",
        "The workspace could not respond to the upgrade request.",
        { retryable: true, exitCode: 5 },
      );
    if (response.status !== (method === "POST" ? 202 : 200)) {
      const body = response.body;
      const error = errorFromResponse(
        isObject(body) && !isObject(body.error)
          ? {
              ...response,
              body: {
                ...body,
                code: body.code ?? (body.message ? body.error : undefined),
                message: body.message ?? body.detail,
              },
            }
          : response,
        "upgrade_request_rejected",
      );
      if (response.status === 404 && error.code !== "upgrade_run_unavailable")
        throw new TeamClawsError(
          "upgrade_endpoint_unavailable",
          "This workspace does not expose the CLI upgrade operation.",
        );
      if (response.status >= 200 && response.status < 300)
        throw invalidUpgradeResponse();
      throw error;
    }
    const next = parseUpgradeRun(response.body);
    const expectedRequestId =
      runId && requestAlias.test(runId)
        ? runId.slice(runPrefix.length)
        : undefined;
    if (expectedRequestId && next.request_id !== expectedRequestId)
      throw invalidUpgradeResponse();
    if (runId && actualRunId.test(runId) && next.run_id !== runId)
      throw invalidUpgradeResponse();
    if (
      (run?.request_id && next.request_id !== run.request_id) ||
      (run?.release_version && next.release_version !== run.release_version) ||
      (run?.release_sha && next.release_sha !== run.release_sha)
    )
      throw invalidUpgradeResponse();
    return next;
  };

  if (operation.kind === "status") {
    try {
      run = await request("GET");
      runId = run.run_id;
      return result(runOutcome(run));
    } catch (error) {
      if (signal?.aborted) return result("interrupted");
      if (isTemporary(error)) return result("temporarily_unreachable", error);
      return result(isUnavailable(error) ? "unavailable" : "rejected", error);
    }
  }

  if (signal?.aborted) return result("interrupted");
  try {
    run = await request("POST");
  } catch (error) {
    if (signal?.aborted) return result("interrupted");
    if (!dispatchedStart || !isAmbiguousStart(error))
      return result(isUnavailable(error) ? "unavailable" : "rejected", error);
    try {
      run = await request("GET");
    } catch (statusError) {
      return result(signal?.aborted ? "interrupted" : "unknown", statusError);
    }
  }
  runId = run.run_id;
  if (run.status !== "running") return result(runOutcome(run));
  if (operation.noWait) return result("accepted");

  let previousProgress = progressMessage(run);
  progress(previousProgress);
  for (;;) {
    try {
      await delay(1_000, undefined, { signal });
      const next = await request("GET");
      run = next;
      if (next.status !== "running") return result(runOutcome(next));
      const message = progressMessage(next);
      if (message !== previousProgress) progress(message);
      previousProgress = message;
    } catch (error) {
      if (signal?.aborted) return result("interrupted");
      if (!isTemporary(error))
        return result(isUnavailable(error) ? "unavailable" : "unknown", error);
      if (previousProgress !== reconnectMessage) progress(reconnectMessage);
      previousProgress = reconnectMessage;
    }
  }
}

const reconnectMessage =
  "ClawGate is temporarily unreachable. Reconnecting to the same run.";

function progressMessage(run: UpgradeRun): string {
  return `ClawGate upgrade ${run.run_id}: ${run.phase ?? "running"}${run.detail ? ` — ${run.detail}` : ""}`;
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof TeamClawsError &&
    ["upgrade_endpoint_unavailable", "upgrade_run_unavailable"].includes(
      error.code,
    )
  );
}

function isTemporary(error: unknown): boolean {
  return (
    error instanceof TeamClawsError &&
    ([
      "network_error",
      "network_timeout",
      "upgrade_temporarily_unreachable",
    ].includes(error.code) ||
      (error.code === "target_proof_denied" && error.retryable))
  );
}

function isAmbiguousStart(error: unknown): boolean {
  return (
    isTemporary(error) ||
    !(error instanceof TeamClawsError) ||
    [
      "invalid_response",
      "invalid_upgrade_response",
      "response_too_large",
    ].includes(error.code)
  );
}

function runOutcome(run: UpgradeRun): Outcome {
  if (run.status === "running") return "running";
  if (run.status === "failed")
    return run.rollback_succeeded ? "rolled_back" : "failed";
  return run.ready && run.release_version && run.release_sha
    ? "ready"
    : "readiness_unverified";
}

function parseUpgradeRun(value: unknown): UpgradeRun {
  if (
    !isObject(value) ||
    typeof value.run_id !== "string" ||
    !actualRunId.test(value.run_id) ||
    (value.request_id !== null &&
      (typeof value.request_id !== "string" ||
        !requestAlias.test(`${runPrefix}${value.request_id}`))) ||
    (value.status !== "running" &&
      value.status !== "succeeded" &&
      value.status !== "failed") ||
    typeof value.ready !== "boolean" ||
    (value.rollback_succeeded !== null &&
      typeof value.rollback_succeeded !== "boolean")
  )
    throw invalidUpgradeResponse();
  return {
    run_id: value.run_id,
    request_id: value.request_id,
    status: value.status,
    phase: safeStatusText(value.phase, 80),
    detail: safeStatusText(value.detail, 500),
    release_version: safeStatusText(value.release_version, 100),
    release_sha: safeStatusText(value.release_sha, 100),
    rollback_succeeded: value.rollback_succeeded,
    ready: value.ready,
  };
}

function safeStatusText(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || !value || value.length > limit) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return null;
  }
  return value;
}

function invalidUpgradeResponse(): TeamClawsError {
  return new TeamClawsError(
    "invalid_upgrade_response",
    "The workspace returned an invalid ClawGate upgrade response.",
    { exitCode: 9 },
  );
}
