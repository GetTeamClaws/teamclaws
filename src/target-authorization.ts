import { createHash, randomUUID } from "node:crypto";

import { API_V2_BASE, OAUTH_TOKEN_URL } from "./constants.js";
import { TeamClawsError } from "./errors.js";
import {
  errorFromResponse,
  requestJson,
  type FetchLike,
  type JsonRequestOptions,
  type JsonResponse,
} from "./http.js";
import {
  OsMachineKeyProvider,
  jwkThumbprint,
  type MachineKeyProvider,
  type MachineKeyReference,
} from "./machine-key.js";
import type { CredentialStore } from "./storage.js";
import type { ServerSummary, StatusWorkspaceCredential } from "./types.js";
import { isObject } from "./validation.js";

export type DurableAuthorization = {
  version: 2;
  authorization_id: string;
  sub: string;
  machine_key: MachineKeyReference;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class TargetAuthorization {
  private readonly fetcher: FetchLike;
  private readonly store: CredentialStore;
  private readonly keys: MachineKeyProvider;
  private readonly now: () => number;

  constructor(
    store: CredentialStore,
    fetcher: FetchLike = fetch,
    keys: MachineKeyProvider = new OsMachineKeyProvider(store.root),
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.fetcher = fetcher;
    this.keys = keys;
    this.now = now;
  }

  async requireGrant(): Promise<DurableAuthorization> {
    const grant = await this.store.readAuthorization();
    if (!grant)
      throw new TeamClawsError(
        "login_required",
        "Approve this CLI at TeamClaws with `teamclaws login <email>` before using a workspace.",
        { exitCode: 3 },
      );
    return grant;
  }

  async accountHeadersFor(
    method: string,
    url: string,
  ): Promise<Record<string, string>> {
    return this.accountHeadersForGrant(await this.requireGrant(), method, url);
  }

  async accountHeadersForGrant(
    grant: DurableAuthorization,
    method: string,
    url: string,
  ): Promise<Record<string, string>> {
    if (new URL(url).origin !== new URL(API_V2_BASE).origin)
      throw new TeamClawsError(
        "invalid_target",
        "A TeamClaws issuer URL is required.",
        { exitCode: 9 },
      );
    return {
      "X-TeamClaws-Authorization-Id": grant.authorization_id,
      DPoP: await this.dpop(grant.machine_key, method, url),
    };
  }

  assertPairing(
    grant: DurableAuthorization,
    credential: StatusWorkspaceCredential,
  ): void {
    if (
      credential.version !== 2 ||
      credential.requester_sub !== grant.sub ||
      credential.authorization_id !== grant.authorization_id ||
      credential.machine_jkt !== grant.machine_key.jkt ||
      credential.pairing_id !== credential.device_id
    ) {
      throw new TeamClawsError(
        "re_pair_required",
        "This pairing is not bound to the current TeamClaws authorization. Pair this workspace again.",
        { exitCode: 3 },
      );
    }
  }

  async headersFor(
    method: string,
    url: string,
    credential: StatusWorkspaceCredential,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const grant = await this.requireGrant();
    this.assertPairing(grant, credential);
    if (new URL(url).origin !== credential.origin)
      throw new TeamClawsError(
        "target_mismatch",
        "The request target does not match the selected pairing.",
        { exitCode: 9 },
      );
    const pairingAuthorization = `Bearer ${credential.device_id}:${credential.device_token}`;
    const exchangeUrl = `${API_V2_BASE}authorizations/${grant.authorization_id}/proofs/`;
    const exchange = await requestJson(this.fetcher, exchangeUrl, {
      method: "POST",
      headers: {
        DPoP: await this.dpop(grant.machine_key, "POST", exchangeUrl),
      },
      body: {
        server_id: credential.server_id,
        pairing_id: credential.pairing_id,
        scope: "paired:invoke",
      },
      ...(signal ? { signal } : {}),
    });
    if (exchange.status < 200 || exchange.status >= 300)
      throw errorFromResponse(exchange, "target_proof_denied");
    if (
      !isObject(exchange.body) ||
      exchange.body.token_type !== "DPoP" ||
      exchange.body.scope !== "paired:invoke" ||
      typeof exchange.body.access_token !== "string" ||
      exchange.body.access_token.length < 16 ||
      exchange.body.access_token.length > 8192 ||
      !Number.isInteger(exchange.body.expires_in) ||
      (exchange.body.expires_in as number) < 1 ||
      (exchange.body.expires_in as number) > 300
    )
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned an invalid target proof.",
        { exitCode: 9 },
      );
    const proof = exchange.body.access_token;
    return {
      Authorization: pairingAuthorization,
      "X-TeamClaws-Target-Proof": proof,
      DPoP: await this.dpop(
        grant.machine_key,
        method,
        url,
        proof,
        pairingAuthorization,
      ),
    };
  }

  async headersForAccountShell(
    method: string,
    url: string,
    server: Pick<ServerSummary, "server_id" | "workspace_url">,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const grant = await this.requireGrant();
    if (new URL(url).origin !== new URL(server.workspace_url).origin)
      throw new TeamClawsError(
        "target_mismatch",
        "The request target does not match the selected workspace.",
        { exitCode: 9 },
      );
    const exchangeUrl = `${API_V2_BASE}authorizations/${grant.authorization_id}/shell-proofs/`;
    const exchange = await requestJson(this.fetcher, exchangeUrl, {
      method: "POST",
      headers: {
        DPoP: await this.dpop(grant.machine_key, "POST", exchangeUrl),
      },
      body: { server_id: server.server_id, scope: "workspace:shell" },
      ...(signal ? { signal } : {}),
    });
    if (exchange.status < 200 || exchange.status >= 300)
      throw errorFromResponse(exchange, "target_proof_denied");
    if (
      !isObject(exchange.body) ||
      exchange.body.token_type !== "DPoP" ||
      exchange.body.scope !== "workspace:shell" ||
      typeof exchange.body.access_token !== "string" ||
      exchange.body.access_token.length < 16 ||
      exchange.body.access_token.length > 8192 ||
      !Number.isInteger(exchange.body.expires_in) ||
      (exchange.body.expires_in as number) < 1 ||
      (exchange.body.expires_in as number) > 300
    )
      throw new TeamClawsError(
        "invalid_response",
        "TeamClaws returned an invalid shell proof.",
        { exitCode: 9 },
      );
    const proof = exchange.body.access_token;
    return {
      Authorization: `DPoP ${proof}`,
      DPoP: await this.dpop(grant.machine_key, method, url, proof),
    };
  }

  async dpop(
    key: MachineKeyReference,
    method: string,
    url: string,
    targetProof?: string,
    pairingAuthorization?: string,
  ): Promise<string> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw new TeamClawsError(
        "invalid_target",
        "A canonical HTTPS target is required.",
        { exitCode: 9 },
      );
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.public_jwk };
    const payload: Record<string, string | number> = {
      htm: method.toUpperCase(),
      htu: `${parsed.origin}${parsed.pathname}`,
      iat: Math.floor(this.now() / 1000),
      jti: randomUUID(),
    };
    if (targetProof !== undefined) payload.ath = hashAscii(targetProof);
    if (pairingAuthorization !== undefined)
      payload.pairing_ath = hashAscii(pairingAuthorization);
    const signingInput = `${base64Json(header)}.${base64Json(payload)}`;
    return `${signingInput}.${await this.keys.sign(key, signingInput)}`;
  }

  async tokenDpop(key: MachineKeyReference): Promise<string> {
    return this.dpop(key, "POST", OAUTH_TOKEN_URL);
  }
}

export async function requestTargetJson(
  fetcher: FetchLike,
  authorization: TargetAuthorization,
  url: string,
  credential: StatusWorkspaceCredential,
  options: JsonRequestOptions = {},
): Promise<JsonResponse> {
  const method = options.method ?? "GET";
  const attempt = async () =>
    requestJson(fetcher, url, {
      ...options,
      headers: {
        ...options.headers,
        ...(await authorization.headersFor(
          method,
          url,
          credential,
          options.signal,
        )),
      },
    });
  const first = await attempt();
  if (
    first.status === 401 &&
    isObject(first.body) &&
    first.body.error === "target_proof_expired"
  )
    return attempt();
  return first;
}

export function parseDurableAuthorization(
  value: unknown,
): DurableAuthorization {
  if (
    !isObject(value) ||
    value.version !== 2 ||
    typeof value.authorization_id !== "string" ||
    !uuid.test(value.authorization_id) ||
    typeof value.sub !== "string" ||
    value.sub.length < 1 ||
    value.sub.length > 255 ||
    !isObject(value.machine_key) ||
    !["windows-cng", "posix-file"].includes(
      String(value.machine_key.provider),
    ) ||
    typeof value.machine_key.name !== "string" ||
    !/^teamclaws-cli-[0-9a-f-]{36}$/u.test(value.machine_key.name) ||
    !isObject(value.machine_key.public_jwk) ||
    value.machine_key.public_jwk.kty !== "EC" ||
    value.machine_key.public_jwk.crv !== "P-256" ||
    typeof value.machine_key.public_jwk.x !== "string" ||
    typeof value.machine_key.public_jwk.y !== "string" ||
    typeof value.machine_key.jkt !== "string"
  )
    throw new TeamClawsError(
      "invalid_credential_file",
      "The saved CLI authorization is invalid.",
      { exitCode: 9 },
    );
  const key = value.machine_key as unknown as MachineKeyReference;
  if (key.jkt !== jwkThumbprint(key.public_jwk))
    throw new TeamClawsError(
      "invalid_credential_file",
      "The saved CLI authorization key is invalid.",
      { exitCode: 9 },
    );
  return value as DurableAuthorization;
}

function hashAscii(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("base64url");
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
