import {
  API_BASE,
  API_V2_BASE,
  API_RESOURCE,
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_AUTHORIZATION_URL,
  OAUTH_LOGIN_TIMEOUT_MS,
  OAUTH_TOKEN_URL,
  TEAMCLAWS_ORIGIN,
} from "./constants.js";
import { TeamClawsError } from "./errors.js";
import { errorFromResponse, requestJson, type FetchLike } from "./http.js";
import type { Output } from "./output.js";
import type { CredentialStore } from "./storage.js";
import type { SafeUser } from "./types.js";
import {
  assertExactKeys,
  isObject,
  parseSafeUserResponse,
  requireHttpsUrl,
  requireInteger,
  requireString,
} from "./validation.js";
import { openExternalBrowser } from "./browser.js";
import {
  OsMachineKeyProvider,
  type MachineKeyProvider,
  type MachineKeyReference,
} from "./machine-key.js";
import {
  TargetAuthorization,
  type DurableAuthorization,
} from "./target-authorization.js";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export type AuthServiceOptions = {
  fetcher?: FetchLike;
  store: CredentialStore;
  output: Output;
  openBrowser?: (url: string) => Promise<boolean>;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  loginTimeoutMs?: number;
  machineKeys?: MachineKeyProvider;
};

export class AuthService {
  private readonly fetcher: FetchLike;
  private readonly store: CredentialStore;
  private readonly output: Output;
  private readonly openBrowser: (url: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly wait: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  private readonly loginTimeoutMs: number;
  private readonly machineKeys: MachineKeyProvider;

  constructor(options: AuthServiceOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.store = options.store;
    this.output = options.output;
    this.openBrowser = options.openBrowser ?? openExternalBrowser;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? waitFor;
    this.loginTimeoutMs = options.loginTimeoutMs ?? OAUTH_LOGIN_TIMEOUT_MS;
    this.machineKeys =
      options.machineKeys ?? new OsMachineKeyProvider(this.store.root);
  }

  async login(email: string, signal?: AbortSignal): Promise<SafeUser> {
    const boundEmail = parseLoginEmail(email);
    const machineKey = await this.machineKeys.create();
    const pending = await this.startDevice(boundEmail, machineKey, signal);
    this.output.loginBrowser(pending.verification_uri_complete);
    await this.openBrowser(pending.verification_uri_complete).catch(
      () => false,
    );
    const { authorization_id, sub, machine_jkt } = await this.poll(
      pending,
      machineKey,
      signal,
    );
    if (machine_jkt !== machineKey.jkt) throw invalidTokenResponse();
    const grant: DurableAuthorization = {
      version: 2,
      authorization_id,
      sub,
      machine_key: machineKey,
    };
    const user = await this.fetchIdentity(grant, signal);
    if (user.id !== sub) throw invalidTokenResponse();
    await this.store.writeAuthorization(grant);
    await this.store.removeLogin();
    this.output.loginComplete(user);
    return user;
  }

  async status(signal?: AbortSignal): Promise<SafeUser | undefined> {
    const grant = await this.store.readAuthorization();
    if (!grant) {
      this.output.authStatus("signed_out");
      return undefined;
    }
    try {
      const user = await this.fetchIdentity(grant, signal);
      this.output.authStatus("signed_in", user);
      return user;
    } catch (error) {
      if (
        error instanceof TeamClawsError &&
        error.code === "invalid_authentication"
      ) {
        await this.store.removeAuthorization();
        await this.store.removeLogin();
        this.output.authStatus("signed_out");
        return undefined;
      }
      throw error;
    }
  }

  async logout(signal?: AbortSignal, revokeGrant = false): Promise<boolean> {
    const grant = await this.store.readAuthorization();
    if (revokeGrant && grant) {
      const url = `${API_V2_BASE}authorizations/${grant.authorization_id}/revoke/`;
      const signer = new TargetAuthorization(
        this.store,
        this.fetcher,
        this.machineKeys,
        this.now,
      );
      const response = await requestJson(this.fetcher, url, {
        method: "POST",
        headers: await signer.accountHeadersForGrant(grant, "POST", url),
        ...(signal ? { signal } : {}),
      });
      if (response.status !== 204)
        throw errorFromResponse(response, "remote_logout_unconfirmed");
    }
    await this.store.removeLogin();
    await this.store.removeAuthorization();
    this.output.logoutComplete(true);
    return true;
  }

  private async startDevice(
    email: string,
    machineKey: MachineKeyReference,
    signal?: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const form = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      resource: API_RESOURCE,
      scope: "basic",
      machine_jwk: JSON.stringify(machineKey.public_jwk),
    });
    form.set("email", email);
    const response = await requestJson(
      this.fetcher,
      OAUTH_DEVICE_AUTHORIZATION_URL,
      {
        method: "POST",
        form,
        ...(signal ? { signal } : {}),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw oauthError(response.status, response.body);
    }
    return parseDeviceAuthorization(response.body);
  }

  private async poll(
    pending: DeviceAuthorization,
    machineKey: MachineKeyReference,
    signal?: AbortSignal,
  ): Promise<{
    authorization_id: string;
    sub: string;
    machine_jkt: string;
  }> {
    const startedAt = this.now();
    const deadline = Math.min(
      startedAt + pending.expires_in * 1_000,
      startedAt + this.loginTimeoutMs,
    );
    let intervalSeconds = pending.interval;
    while (this.now() < deadline) {
      await this.wait(intervalSeconds * 1_000, signal);
      if (this.now() >= deadline) break;
      const response = await requestJson(this.fetcher, OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          DPoP: await new TargetAuthorization(
            this.store,
            this.fetcher,
            this.machineKeys,
            this.now,
          ).tokenDpop(machineKey),
        },
        form: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: pending.device_code,
          client_id: OAUTH_CLIENT_ID,
          resource: API_RESOURCE,
        }),
        ...(signal ? { signal } : {}),
      });
      if (response.status >= 200 && response.status < 300) {
        if (!isObject(response.body)) throw invalidTokenResponse();
        validateBootstrapTokens(response.body);
        return {
          authorization_id: requireString(
            response.body.authorization_id,
            "authorization ID",
            36,
          ),
          sub: requireString(response.body.sub, "user subject", 255),
          machine_jkt: requireString(
            response.body.machine_jkt,
            "machine key thumbprint",
            43,
          ),
        };
      }
      const code = oauthErrorCode(response.body);
      if (code === "authorization_pending") {
        continue;
      }
      if (code === "slow_down") {
        intervalSeconds = Math.min(intervalSeconds + 5, 60);
        continue;
      }
      if (code === "access_denied") {
        throw new TeamClawsError(
          "login_denied",
          "TeamClaws denied the CLI sign-in.",
          { exitCode: 3 },
        );
      }
      if (code === "expired_token") {
        throw new TeamClawsError(
          "login_timeout",
          "CLI sign-in timed out after 10 minutes.",
          { exitCode: 3 },
        );
      }
      throw oauthError(response.status, response.body);
    }
    throw new TeamClawsError(
      "login_timeout",
      "CLI sign-in timed out after 10 minutes.",
      { exitCode: 3 },
    );
  }

  private async fetchIdentity(
    grant: DurableAuthorization,
    signal?: AbortSignal,
  ): Promise<SafeUser> {
    const url = `${API_BASE}me/`;
    const signer = new TargetAuthorization(
      this.store,
      this.fetcher,
      this.machineKeys,
      this.now,
    );
    const response = await requestJson(this.fetcher, url, {
      headers: await signer.accountHeadersForGrant(grant, "GET", url),
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
      throw errorFromResponse(response, "identity_unavailable");
    }
    if (
      !isObject(response.body) ||
      response.body.authorization_id !== grant.authorization_id
    )
      throw invalidTokenResponse();
    const user = parseSafeUserResponse(response.body);
    if (user.id !== grant.sub) throw invalidTokenResponse();
    return user;
  }
}

type DeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

function parseDeviceAuthorization(body: unknown): DeviceAuthorization {
  if (!isObject(body)) throw invalidTokenResponse();
  assertExactKeys(
    body,
    [
      "device_code",
      "user_code",
      "verification_uri",
      "verification_uri_complete",
      "expires_in",
      "interval",
    ],
    [],
    "device authorization response",
  );
  const deviceCode = requireToken(body.device_code);
  const userCode = requireString(body.user_code, "user code", 32);
  const verificationUri = trustedTeamClawsUrl(
    body.verification_uri,
    "verification address",
  );
  const verificationUriComplete = trustedTeamClawsUrl(
    body.verification_uri_complete,
    "complete verification address",
  );
  if (
    verificationUriComplete.origin !== verificationUri.origin ||
    verificationUriComplete.pathname !== verificationUri.pathname ||
    verificationUriComplete.searchParams.get("user_code") !== userCode ||
    ownerUrlLeaksSecret(verificationUriComplete, deviceCode)
  ) {
    throw invalidTokenResponse();
  }
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri.toString(),
    verification_uri_complete: verificationUriComplete.toString(),
    expires_in: requireInteger(body.expires_in, "expires_in", 1, 86_400),
    interval: requireInteger(body.interval, "interval", 1, 60),
  };
}

function validateBootstrapTokens(body: unknown): void {
  if (!isObject(body)) throw invalidTokenResponse();
  requireToken(body.access_token);
  requireToken(body.refresh_token);
  if (body.token_type !== "Bearer") throw invalidTokenResponse();
  requireInteger(body.expires_in, "access-token lifetime", 1, 86_400);
}

function parseLoginEmail(value: string): string {
  const email = value.trim();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !email.includes("@") ||
    email.includes(" ")
  ) {
    throw new TeamClawsError(
      "invalid_command",
      "Provide a valid email address to bind this TeamClaws CLI login.",
      { exitCode: 2 },
    );
  }
  return email;
}

function requireToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 8_192) {
    throw invalidTokenResponse();
  }
  return value;
}

function trustedTeamClawsUrl(value: unknown, label: string): URL {
  const url = requireHttpsUrl(value, label);
  if (url.origin !== TEAMCLAWS_ORIGIN) throw invalidTokenResponse();
  return url;
}

function ownerUrlLeaksSecret(url: URL, deviceCode: string): boolean {
  let decoded = url.toString();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return true;
  }
  return (
    decoded.includes(deviceCode) ||
    /(?:access_token|refresh_token|device_code)=/iu.test(decoded)
  );
}

function invalidTokenResponse(): TeamClawsError {
  return new TeamClawsError(
    "invalid_response",
    "TeamClaws returned an invalid login response.",
    {
      exitCode: 9,
    },
  );
}

function oauthErrorCode(body: unknown): string {
  if (
    isObject(body) &&
    typeof body.error === "string" &&
    body.error.length <= 80
  ) {
    return body.error;
  }
  return "";
}

function oauthError(status: number, body: unknown): TeamClawsError {
  let code = "login_failed";
  const error = oauthErrorCode(body);
  if (error) {
    code = error === "invalid_grant" ? "invalid_authentication" : error;
  }
  const message =
    error === "invalid_grant"
      ? "The TeamClaws login is no longer valid. Run `teamclaws login <email>` to authenticate."
      : "TeamClaws rejected the login request.";
  return new TeamClawsError(code, message, {
    retryable: status >= 500,
    exitCode: 3,
  });
}

async function waitFor(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new TeamClawsError("cancelled", "Login was cancelled.", {
          exitCode: 8,
        }),
      );
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        new TeamClawsError("cancelled", "Login was cancelled.", {
          exitCode: 8,
        }),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
