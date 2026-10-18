import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

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
  PairingTarget,
  PendingPairing,
  WorkspaceInventory,
} from "./types.js";
import { parsePendingPairing, parseWorkspaceInventory } from "./validation.js";

export type BrokerOptions = {
  fetcher?: FetchLike;
  deviceName?: () => string;
};

export class BrokerClient {
  private readonly fetcher: FetchLike;
  private readonly deviceName: () => string;

  constructor(options: BrokerOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.deviceName = options.deviceName ?? hostname;
  }

  currentDeviceName(): string {
    return normalizedDeviceName(this.deviceName());
  }

  async servers(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceInventory> {
    const response = await requestJson(
      this.fetcher,
      `${API_BASE}servers/?include_inventory=1&include_description=1`,
      {
        headers: requestHeaders(accessToken),
        ...(signal ? { signal } : {}),
      },
    );
    if (response.status === 401) {
      throw new TeamClawsError(
        "invalid_authentication",
        "The TeamClaws login is no longer valid. Run `teamclaws login` to authenticate.",
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

  async startPairing(
    target: PairingTarget,
    accessToken?: string,
    signal?: AbortSignal,
  ): Promise<PendingPairing> {
    const request = pairingStartRequest(target, this.currentDeviceName());
    const response = await requestJson(
      this.fetcher,
      `${API_BASE}pairing/start/`,
      {
        method: "POST",
        headers: requestHeaders(accessToken),
        body: request,
        ...(signal ? { signal } : {}),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw errorFromResponse(response, "pairing_start_failed");
    }
    const pending = parsePendingPairing(response.body);
    if ("server_id" in target && pending.server_id !== target.server_id) {
      throw new TeamClawsError(
        "target_mismatch",
        "TeamClaws resolved a different workspace than the one requested.",
        { exitCode: 9 },
      );
    }
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
}

export function pairingStartRequest(
  target: PairingTarget,
  deviceName: string,
): Record<string, unknown> {
  return {
    contract_version: CONTRACT_VERSION,
    target,
    request_id: randomUUID(),
    device_name: deviceName,
    client_name: CLIENT_NAME,
    client_version: PACKAGE_VERSION,
  };
}

export function normalizedDeviceName(value: string): string {
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DEVICE_NAME_LENGTH);
  return normalized || "Unnamed computer";
}

function requestHeaders(accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": `${CLIENT_NAME}/${PACKAGE_VERSION}`.slice(
      0,
      MAX_CLIENT_LABEL_LENGTH,
    ),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}
