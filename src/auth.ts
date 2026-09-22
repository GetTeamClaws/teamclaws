import {
  ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
  API_BASE,
  API_RESOURCE,
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_AUTHORIZATION_URL,
  OAUTH_LOGIN_TIMEOUT_MS,
  OAUTH_REVOKE_URL,
  OAUTH_TOKEN_URL,
  TEAMCLAWS_ORIGIN,
} from "./constants.js";
import { TeamClawsError } from "./errors.js";
import { errorFromResponse, requestJson, type FetchLike } from "./http.js";
import type { Output } from "./output.js";
import type { CredentialStore } from "./storage.js";
import type { LoginCredential, SafeUser } from "./types.js";
import {
  assertExactKeys,
  isObject,
  parseSafeUserResponse,
  requireHttpsUrl,
  requireInteger,
  requireString,
} from "./validation.js";
import { openExternalBrowser } from "./browser.js";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export type AuthServiceOptions = {
  fetcher?: FetchLike;
  store: CredentialStore;
  output: Output;
  openBrowser?: (url: string) => Promise<boolean>;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  loginTimeoutMs?: number;
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

  constructor(options: AuthServiceOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.store = options.store;
    this.output = options.output;
    this.openBrowser = options.openBrowser ?? openExternalBrowser;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? waitFor;
    this.loginTimeoutMs = options.loginTimeoutMs ?? OAUTH_LOGIN_TIMEOUT_MS;
  }

  async login(email?: string, signal?: AbortSignal): Promise<SafeUser> {
    const boundEmail = email === undefined ? undefined : parseLoginEmail(email);
    const pending = await this.startDevice(boundEmail, signal);
    this.output.loginBrowser(pending.verification_uri_complete);
    await this.openBrowser(pending.verification_uri_complete).catch(
      () => false,
    );
    const credential = await this.poll(pending, signal);
    const user = await this.fetchIdentity(credential.access_token, signal);
    await this.store.writeLogin(credential);
    this.output.loginComplete(user);
    return user;
  }

  async status(signal?: AbortSignal): Promise<SafeUser | undefined> {
    const credential = await this.store.readLogin();
    if (!credential) {
      this.output.authStatus("signed_out");
      return undefined;
    }
    try {
      const active = await this.ensureActive(credential, signal);
      const user = await this.fetchIdentity(active.access_token, signal);
      this.output.authStatus("signed_in", user, active.expires_at);
      return user;
    } catch (error) {
      if (
        error instanceof TeamClawsError &&
        error.code === "invalid_authentication"
      ) {
        await this.store.removeLogin();
        this.output.authStatus("signed_out");
        return undefined;
      }
      throw error;
    }
  }

  async logout(signal?: AbortSignal): Promise<boolean> {
    const credential = await this.store.readLogin();
    let remoteConfirmed = true;
    if (credential) {
      try {
        await this.revoke(credential.refresh_token, signal);
      } catch {
        remoteConfirmed = false;
      }
    }
    await this.store.removeLogin();
    this.output.logoutComplete(remoteConfirmed);
    return remoteConfirmed;
  }

  async accessToken(signal?: AbortSignal): Promise<string | undefined> {
    const credential = await this.store.readLogin();
    if (!credential) return undefined;
    const active = await this.ensureActive(credential, signal);
    return active.access_token;
  }

  async requireAccessToken(
    message: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const token = await this.accessToken(signal);
    if (!token) {
      throw new TeamClawsError("login_required", message, { exitCode: 3 });
    }
    await this.fetchIdentity(token, signal);
    return token;
  }

  private async ensureActive(
    credential: LoginCredential,
    signal?: AbortSignal,
  ): Promise<LoginCredential> {
    const expiresAt = Date.parse(credential.expires_at);
    if (expiresAt - this.now() > 30_000) return credential;
    const refreshed = await this.refresh(credential.refresh_token, signal);
    await this.store.writeLogin(refreshed);
    return refreshed;
  }

  private async startDevice(
    email: string | undefined,
    signal?: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const form = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      resource: API_RESOURCE,
    });
    if (email) form.set("email", email);
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
    signal?: AbortSignal,
  ): Promise<LoginCredential> {
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
        form: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: pending.device_code,
          client_id: OAUTH_CLIENT_ID,
          resource: API_RESOURCE,
        }),
        ...(signal ? { signal } : {}),
      });
      if (response.status >= 200 && response.status < 300) {
        return parseTokenResponse(response.body, this.now());
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

  private async refresh(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<LoginCredential> {
    try {
      const response = await requestJson(this.fetcher, OAUTH_TOKEN_URL, {
        method: "POST",
        form: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: OAUTH_CLIENT_ID,
          resource: API_RESOURCE,
        }),
        ...(signal ? { signal } : {}),
      });
      if (response.status < 200 || response.status >= 300) {
        throw oauthError(response.status, response.body);
      }
      return parseTokenResponse(response.body, this.now());
    } catch (error) {
      if (
        error instanceof TeamClawsError &&
        error.code === "invalid_authentication"
      ) {
        await this.store.removeLogin();
      }
      throw error;
    }
  }

  private async fetchIdentity(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<SafeUser> {
    const response = await requestJson(this.fetcher, `${API_BASE}me/`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(signal ? { signal } : {}),
    });
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
      throw errorFromResponse(response, "identity_unavailable");
    }
    return parseSafeUserResponse(response.body);
  }

  private async revoke(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(10_000);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const response = await this.fetcher(OAUTH_REVOKE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      redirect: "error",
      signal: combined,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new TeamClawsError(
        "remote_logout_unconfirmed",
        "Remote logout was not confirmed.",
      );
    }
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

function parseTokenResponse(body: unknown, now: number): LoginCredential {
  if (!isObject(body)) throw invalidTokenResponse();
  const accessToken = requireToken(body.access_token);
  const refreshToken = requireToken(body.refresh_token);
  if (body.token_type !== "Bearer") throw invalidTokenResponse();
  const expiresIn = Math.min(
    requireInteger(body.expires_in, "access-token lifetime", 1, 86_400),
    ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
  );
  return {
    version: 1,
    token_type: "Bearer",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(now + expiresIn * 1_000).toISOString(),
  };
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
      ? "The TeamClaws login is no longer valid. Run `teamclaws login` to authenticate."
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
