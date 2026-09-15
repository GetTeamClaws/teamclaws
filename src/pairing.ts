import { parseCapabilityInventory } from "./external-chat.js";
import type { CapabilityInventory } from "./types.js";
import { TeamClawsError } from "./errors.js";
import { PAIRING_STATUS_TIMEOUT_MS } from "./constants.js";
import {
  errorFromResponse,
  requestJson,
  type FetchLike,
  type JsonResponse,
} from "./http.js";
import type { Output } from "./output.js";
import type { CredentialStore } from "./storage.js";
import type {
  PairingCredential,
  PairingStatus,
  PairingTarget,
  PendingPairing,
  VerifiedWorkspace,
  WorkspaceCredential,
} from "./types.js";
import {
  directTargetUrl,
  isObject,
  parsePairingCredential,
  parseVerifiedDevice,
  parseVerifiedWorkspace,
  requireInteger,
} from "./validation.js";
import { openExternalBrowser } from "./browser.js";

export type PairingOptions = {
  fetcher?: FetchLike;
  store: CredentialStore;
  output: Output;
  openBrowser?: (url: string) => Promise<boolean>;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export class PairingClient {
  private readonly fetcher: FetchLike;
  private readonly store: CredentialStore;
  private readonly output: Output;
  private readonly openBrowser: (url: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly wait: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;

  constructor(options: PairingOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.store = options.store;
    this.output = options.output;
    this.openBrowser = options.openBrowser ?? openExternalBrowser;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? waitFor;
  }

  async status(
    target: PairingTarget,
    signal?: AbortSignal,
  ): Promise<PairingStatus> {
    let credential;
    try {
      credential = await this.store.findWorkspace(target);
    } catch {
      this.output.pairingStatus("unreachable");
      return "unreachable";
    }
    if (!credential) {
      this.output.pairingStatus("not_paired");
      return "not_paired";
    }
    const workspace = {
      server_id: credential.server_id,
      origin: credential.origin,
      display_name: credential.display_name,
    };
    try {
      const response = await requestJson(
        this.fetcher,
        `${credential.origin}/teamclaws-admin/api/device-pairings/me/`,
        {
          headers: {
            Authorization: `Bearer ${credential.device_id}:${credential.device_token}`,
          },
          timeoutMs: PAIRING_STATUS_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        },
      );
      if (response.status === 401 || response.status === 403) {
        this.output.pairingStatus("credential_rejected", workspace);
        return "credential_rejected";
      }
      if (response.status < 200 || response.status >= 300) {
        this.output.pairingStatus("unreachable", workspace);
        return "unreachable";
      }
      const displayName = parseVerifiedDevice(
        response.body,
        credential.device_id,
      );
      this.output.pairingStatus("paired", {
        ...workspace,
        display_name: displayName,
      });
      return "paired";
    } catch (error) {
      if (signal?.aborted) throw error;
      this.output.pairingStatus("unreachable", workspace);
      return "unreachable";
    }
  }

  async complete(
    pending: PendingPairing,
    deviceName: string,
    noOpen: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.output.pairingBrowser(
      pending.verification_uri_complete,
      pending.user_code,
      pending.agent_action,
    );
    if (!noOpen) await this.openBrowser(pending.verification_uri_complete);
    let credential: PairingCredential | undefined;
    try {
      credential = await this.poll(pending, signal);
      const initial: WorkspaceCredential = {
        version: 1,
        server_id: pending.server_id,
        origin: pending.target.origin,
        display_name: deviceName,
        device_id: credential.device_id,
        device_token: credential.device_token,
        created_at: new Date(this.now()).toISOString(),
      };
      await this.store.writeWorkspace(initial);
      try {
        const stored = await this.store.readWorkspace(pending.server_id);
        if (!stored) throw verificationError();
        const verification = await this.verify(pending, stored, signal);
        const verified = {
          ...stored,
          display_name: verification.display_name,
        };
        await this.store.writeWorkspace(verified);
        let snapshot: CapabilityInventory | null | undefined;
        let generatedAt: string | null | undefined;
        if (Object.hasOwn(credential, "external_chat_capabilities")) {
          snapshot = null;
          generatedAt = null;
          try {
            const timestamp =
              credential.external_chat_capabilities_generated_at;
            if (
              typeof timestamp === "string" &&
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(
                timestamp,
              ) &&
              Number.isFinite(Date.parse(timestamp))
            ) {
              snapshot = parseCapabilityInventory(
                credential.external_chat_capabilities,
              );
              generatedAt = timestamp;
            }
          } catch {
            // Optional inventory must not invalidate a successfully verified credential.
          }
        }
        this.output.pairingComplete(
          pending.server_id,
          pending.target.origin,
          verification.display_name,
          verification.external_chat_handoff,
          snapshot,
          generatedAt,
        );
      } catch (error) {
        await this.store.removeWorkspace(pending.server_id);
        throw error;
      }
    } catch (error) {
      if (signal?.aborted) {
        await this.cancel(pending).catch(() => undefined);
        throw new TeamClawsError("cancelled", "Pairing was cancelled.", {
          exitCode: 8,
        });
      }
      throw error;
    } finally {
      credential = undefined;
      void credential;
    }
  }

  private async poll(
    pending: PendingPairing,
    signal?: AbortSignal,
  ): Promise<PairingCredential> {
    const deadline = this.now() + pending.expires_in * 1_000;
    let intervalSeconds = pending.interval;
    const pollUrl = directTargetUrl(
      pending.target,
      pending.target.token_poll_path,
    );
    while (this.now() < deadline) {
      if (signal?.aborted)
        throw new TeamClawsError("cancelled", "Pairing was cancelled.");
      const response = await requestJson(this.fetcher, pollUrl, {
        method: "POST",
        body: { device_code: pending.device_code },
        ...(signal ? { signal } : {}),
      });
      if (response.status >= 200 && response.status < 300) {
        if (response.status === 202) {
          intervalSeconds = pendingInterval(response, intervalSeconds);
          await this.wait(intervalSeconds * 1_000, signal);
          continue;
        }
        return parsePairingCredential(response.body);
      }
      if (response.status === 429) {
        intervalSeconds = slowDownInterval(response, intervalSeconds);
        await this.wait(intervalSeconds * 1_000, signal);
        continue;
      }
      const protocolError = errorFromResponse(response, "pairing_failed");
      throw mapPairingError(protocolError);
    }
    throw new TeamClawsError(
      "pairing_expired",
      "The pairing request expired.",
      { exitCode: 7 },
    );
  }

  private async cancel(pending: PendingPairing): Promise<void> {
    const response = await requestJson(
      this.fetcher,
      directTargetUrl(pending.target, pending.target.cancellation_path),
      {
        method: "POST",
        body: { device_code: pending.device_code },
        timeoutMs: 5_000,
      },
    );
    if (response.status < 200 || response.status >= 300)
      throw errorFromResponse(response, "cancel_failed");
  }

  private async verify(
    pending: PendingPairing,
    credential: WorkspaceCredential,
    signal?: AbortSignal,
  ): Promise<VerifiedWorkspace> {
    const response = await requestJson(
      this.fetcher,
      directTargetUrl(
        pending.target,
        pending.target.credential_verification_path,
      ),
      {
        headers: {
          Authorization: `Bearer ${credential.device_id}:${credential.device_token}`,
        },
        ...(signal ? { signal } : {}),
      },
    );
    if (response.status < 200 || response.status >= 300)
      throw verificationError();
    return parseVerifiedWorkspace(
      response.body,
      credential.device_id,
      credential.origin,
    );
  }
}

function pendingInterval(response: JsonResponse, fallback: number): number {
  if (
    !isObject(response.body) ||
    response.body.status !== "authorization_pending"
  ) {
    throw new TeamClawsError(
      "invalid_response",
      "The workspace returned an invalid pending response.",
      {
        exitCode: 9,
      },
    );
  }
  return requireInteger(
    response.body.interval ?? fallback,
    "polling interval",
    1,
    60,
  );
}

function slowDownInterval(response: JsonResponse, current: number): number {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isInteger(header) && header > 0 && header <= 300) return header;
  if (isObject(response.body)) {
    const seconds = Number(response.body.retry_after_seconds);
    if (Number.isInteger(seconds) && seconds > 0 && seconds <= 300)
      return seconds;
  }
  return Math.min(current + 5, 60);
}

function mapPairingError(error: TeamClawsError): TeamClawsError {
  if (
    ["denied", "authorization_denied", "pairing_denied"].includes(error.code)
  ) {
    return new TeamClawsError(
      "pairing_denied",
      "The workspace owner denied pairing.",
      { exitCode: 6 },
    );
  }
  if (["expired", "pairing_expired"].includes(error.code)) {
    return new TeamClawsError(
      "pairing_expired",
      "The pairing request expired.",
      { exitCode: 7 },
    );
  }
  if (["cancelled", "canceled", "pairing_cancelled"].includes(error.code)) {
    return new TeamClawsError(
      "pairing_cancelled",
      "The pairing request was cancelled.",
      { exitCode: 8 },
    );
  }
  return error;
}

function verificationError(): TeamClawsError {
  return new TeamClawsError(
    "credential_verification_failed",
    "The workspace credential could not be verified and was not retained.",
    { exitCode: 9 },
  );
}

async function waitFor(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new TeamClawsError("cancelled", "Pairing was cancelled.", {
          exitCode: 8,
        }),
      );
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        new TeamClawsError("cancelled", "Pairing was cancelled.", {
          exitCode: 8,
        }),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
