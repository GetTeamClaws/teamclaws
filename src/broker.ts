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
  requireString,
} from "./validation.js";

export type BrokerOptions = {
  fetcher?: FetchLike;
  deviceName?: () => string;
  authorization?: TargetAuthorization;
};

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
    const url = `${API_BASE}servers/?include_inventory=1&include_description=1&include_editable_metadata=1&include_subscription=1`;
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
    assertExactKeys(response.body, ["server"], [], "server metadata response");
    return editableServer(response.body.server, id);
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
      "server metadata prompt response",
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

function invalidMetadataResponse(): TeamClawsError {
  return new TeamClawsError(
    "invalid_response",
    "TeamClaws returned invalid server metadata.",
    { exitCode: 9 },
  );
}

function editableServer(value: unknown, expectedId: string): ServerMetadata {
  if (!isObject(value)) throw invalidMetadataResponse();
  assertExactKeys(
    value,
    ["id", "alias", "description", "custom_alias", "can_edit_metadata"],
    [],
    "server metadata",
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
    alias: requireString(value.alias, "server alias", 200),
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
