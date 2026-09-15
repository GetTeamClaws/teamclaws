import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthService } from "../src/auth.js";
import type { FetchLike } from "../src/http.js";
import { Output } from "../src/output.js";
import { CredentialStore } from "../src/storage.js";
import type { LoginCredential } from "../src/types.js";
import { fixture, jsonResponse, MemoryWritable } from "./helpers.js";

const roots: string[] = [];
const NOW = Date.parse("2026-08-27T13:00:00.000Z");

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("independent TeamClaws login", () => {
  it("completes device authorization login, verifies identity, and stores credentials privately", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    const stdout = new MemoryWritable();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const me = await fixture("contracts/me.json");
    let polls = 0;
    const waits: number[] = [];
    const fetcher: FetchLike = vi.fn(async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      if (String(url).endsWith("/o/device-authorization/")) {
        return jsonResponse({
          device_code: "secret-device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://www.teamclaws.com/o/device/",
          verification_uri_complete:
            "https://www.teamclaws.com/o/device/?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 1,
        });
      }
      if (String(url).endsWith("/o/token/")) {
        polls += 1;
        if (polls === 1) {
          return jsonResponse({ error: "authorization_pending" }, 400);
        }
        return jsonResponse({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          token_type: "Bearer",
          expires_in: 600,
        });
      }
      return jsonResponse(me);
    });
    const openBrowser = vi.fn(async () => false);
    const auth = new AuthService({
      fetcher,
      store,
      output: new Output(true, stdout, new MemoryWritable()),
      openBrowser,
      now: () => NOW,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      loginTimeoutMs: 5_000,
    });
    await auth.login("user@example.com");
    const stored = await store.readLogin();
    expect(stored).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_at: "2026-08-27T13:10:00.000Z",
    });
    expect(String(calls[0]?.url)).toBe(
      "https://www.teamclaws.com/o/device-authorization/",
    );
    expect(String(calls[0]?.init?.body)).toContain("client_id=teamclaws-cli");
    expect(String(calls[0]?.init?.body)).toContain(
      "resource=https%3A%2F%2Fwww.teamclaws.com%2Fapi%2Fcli%2Fv1",
    );
    expect(String(calls[0]?.init?.body)).toContain("email=user%40example.com");
    expect(String(calls[0]?.init?.body)).not.toContain("client_secret");
    expect(String(calls[1]?.init?.body)).toContain(
      "device_code=secret-device-code",
    );
    expect(new Headers(calls[3]?.init?.headers).get("authorization")).toBe(
      "Bearer new-access-token",
    );
    expect(JSON.parse(stdout.value.split("\n")[0]!)).toMatchObject({
      event: "login_browser_required",
      url: "https://www.teamclaws.com/o/device/?user_code=ABCD-EFGH",
    });
    expect(stdout.value).not.toContain("secret-device-code");
    expect(stdout.value).not.toContain("new-access-token");
    expect(stdout.value).not.toContain("new-refresh-token");
    expect(openBrowser).toHaveBeenCalledWith(
      "https://www.teamclaws.com/o/device/?user_code=ABCD-EFGH",
    );
    expect(waits).toEqual([1_000, 1_000]);
  });

  it("reports signed out when no local login exists", async () => {
    const stdout = new MemoryWritable();
    const auth = new AuthService({
      store: new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      }),
      output: new Output(true, stdout, new MemoryWritable()),
      fetcher: vi.fn(),
      now: () => NOW,
    });
    await expect(auth.status()).resolves.toBeUndefined();
    expect(JSON.parse(stdout.value)).toMatchObject({
      event: "auth_status",
      status: "signed_out",
    });
  });

  it("reports an active signed-in identity", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeLogin(loginCredential("2026-08-27T14:00:00.000Z"));
    const stdout = new MemoryWritable();
    const auth = new AuthService({
      store,
      output: new Output(true, stdout, new MemoryWritable()),
      fetcher: vi.fn(async () =>
        jsonResponse(await fixture("contracts/me.json")),
      ),
      now: () => NOW,
    });
    await expect(auth.status()).resolves.toMatchObject({
      email: "user@example.com",
    });
    expect(JSON.parse(stdout.value)).toMatchObject({
      event: "auth_status",
      status: "signed_in",
    });
  });

  it("rotates an expired login and preserves the opaque access token for identity", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeLogin(loginCredential("2026-08-27T12:00:00.000Z"));
    const me = await fixture("contracts/me.json");
    const rotatedAccessToken = "opaque-access-token.jti-like-segment.not-a-jwt";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: FetchLike = vi.fn(async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      if (String(url).endsWith("/o/token/")) {
        return jsonResponse({
          access_token: rotatedAccessToken,
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 900,
        });
      }
      if (String(url).endsWith("/api/cli/v1/me/")) {
        return jsonResponse(me);
      }
      throw new Error("unexpected request");
    });
    const auth = new AuthService({
      fetcher,
      store,
      output: new Output(true, new MemoryWritable(), new MemoryWritable()),
      now: () => NOW,
    });
    await expect(auth.status()).resolves.toMatchObject({
      email: "user@example.com",
    });
    expect(calls.map(({ url }) => url)).toEqual([
      "https://www.teamclaws.com/o/token/",
      "https://www.teamclaws.com/api/cli/v1/me/",
    ]);
    const refreshForm = new URLSearchParams(String(calls[0]?.init?.body));
    expect(Object.fromEntries(refreshForm)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "existing-refresh-token",
      client_id: "teamclaws-cli",
      resource: "https://www.teamclaws.com/api/cli/v1",
    });
    expect(
      new Headers(calls[0]?.init?.headers).get("authorization"),
    ).toBeNull();
    expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe(
      `Bearer ${rotatedAccessToken}`,
    );
    expect(await store.readLogin()).toEqual({
      version: 1,
      token_type: "Bearer",
      access_token: rotatedAccessToken,
      refresh_token: "rotated-refresh-token",
      expires_at: "2026-08-27T13:10:00.000Z",
    });
  });

  it("removes an expired local login when refresh returns invalid_grant", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeLogin(loginCredential("2026-08-27T12:00:00.000Z"));
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const fetcher: FetchLike = vi.fn(async () =>
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "private server detail",
          refresh_token: "server-must-not-echo-this-token",
        },
        400,
      ),
    );
    const auth = new AuthService({
      fetcher,
      store,
      output: new Output(true, stdout, stderr),
      now: () => NOW,
    });
    await expect(auth.accessToken()).rejects.toMatchObject({
      code: "invalid_authentication",
      message: "TeamClaws rejected the login request.",
      exitCode: 3,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = vi.mocked(fetcher).mock.calls[0];
    const refreshForm = new URLSearchParams(String(request?.[1]?.body));
    expect(refreshForm.getAll("refresh_token")).toEqual([
      "existing-refresh-token",
    ]);
    expect(await store.readLogin()).toBeUndefined();
    expect(stdout.value).toBe("");
    expect(stderr.value).toBe("");
  });

  it("always removes local login when remote revocation fails", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeLogin(loginCredential("2026-08-27T14:00:00.000Z"));
    const stdout = new MemoryWritable();
    const fetcher: FetchLike = vi.fn(async () => {
      throw new Error("offline");
    });
    const auth = new AuthService({
      fetcher,
      store,
      output: new Output(true, stdout, new MemoryWritable()),
      now: () => NOW,
    });
    await expect(auth.logout()).resolves.toBe(false);
    expect(await store.readLogin()).toBeUndefined();
    expect(JSON.parse(stdout.value)).toMatchObject({
      event: "logout_complete",
      status: "local_only_warning",
    });
  });

  it("confirms remote revocation and removes local login", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeLogin(loginCredential("2026-08-27T14:00:00.000Z"));
    const auth = new AuthService({
      store,
      output: new Output(true, new MemoryWritable(), new MemoryWritable()),
      fetcher: vi.fn(async () => new Response(null, { status: 200 })),
      now: () => NOW,
    });
    await expect(auth.logout()).resolves.toBe(true);
    expect(await store.readLogin()).toBeUndefined();
  });

  it("keeps the device code in memory after presenting the owner URL and maps deny", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    const stdout = new MemoryWritable();
    let presented = false;
    const fetcher: FetchLike = vi.fn(async (url) => {
      if (String(url).endsWith("/o/device-authorization/")) {
        return jsonResponse({
          device_code: "secret-device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://www.teamclaws.com/o/device/",
          verification_uri_complete:
            "https://www.teamclaws.com/o/device/?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 1,
        });
      }
      if (presented) {
        return jsonResponse({ error: "access_denied" }, 400);
      }
      throw new Error("polled before presenting the owner URL");
    });
    const auth = new AuthService({
      store,
      output: new Output(true, stdout, new MemoryWritable()),
      fetcher,
      openBrowser: async () => {
        presented = true;
        return false;
      },
      now: () => NOW,
      wait: async () => undefined,
      loginTimeoutMs: 5_000,
    });
    await expect(auth.login()).rejects.toMatchObject({ code: "login_denied" });
    expect(stdout.value).toContain(
      "https://www.teamclaws.com/o/device/?user_code=ABCD-EFGH",
    );
    expect(stdout.value).not.toContain("secret-device-code");
    expect(await store.readLogin()).toBeUndefined();
  });

  it.each([
    "https://attacker.example/o/device/?user_code=ABCD-EFGH",
    "https://www.teamclaws.com/o/device/?user_code=ABCD-EFGH&device_code=secret-device-code",
    "https://www.teamclaws.com/o/device/?user_code=ABCD-EFGH&access_token=secret-access-token",
  ])(
    "rejects an unsafe owner URL before presenting or polling: %s",
    async (ownerUrl) => {
      const store = new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      });
      const stdout = new MemoryWritable();
      const fetcher: FetchLike = vi.fn(async () =>
        jsonResponse({
          device_code: "secret-device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://www.teamclaws.com/o/device/",
          verification_uri_complete: ownerUrl,
          expires_in: 600,
          interval: 1,
        }),
      );
      const openBrowser = vi.fn(async () => true);
      const auth = new AuthService({
        store,
        output: new Output(true, stdout, new MemoryWritable()),
        fetcher,
        openBrowser,
        now: () => NOW,
      });
      await expect(auth.login()).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(openBrowser).not.toHaveBeenCalled();
      expect(stdout.value).toBe("");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("increases the RFC 8628 polling interval after slow_down", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    const waits: number[] = [];
    let polls = 0;
    const fetcher: FetchLike = vi.fn(async (url) => {
      if (String(url).endsWith("/o/device-authorization/")) {
        return jsonResponse({
          device_code: "secret-device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://www.teamclaws.com/o/device/",
          verification_uri_complete:
            "https://www.teamclaws.com/o/device/?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 1,
        });
      }
      if (String(url).endsWith("/o/token/")) {
        polls += 1;
        if (polls === 1) return jsonResponse({ error: "slow_down" }, 400);
        return jsonResponse({ error: "access_denied" }, 400);
      }
      throw new Error("unexpected request");
    });
    const auth = new AuthService({
      store,
      output: new Output(true, new MemoryWritable(), new MemoryWritable()),
      fetcher,
      openBrowser: async () => false,
      now: () => NOW,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    await expect(auth.login()).rejects.toMatchObject({ code: "login_denied" });
    expect(waits).toEqual([1_000, 6_000]);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "teamclaws-auth-test-"));
  roots.push(root);
  return join(root, "private");
}

function loginCredential(expiresAt: string): LoginCredential {
  return {
    version: 1,
    token_type: "Bearer",
    access_token: "existing-access-token",
    refresh_token: "existing-refresh-token",
    expires_at: expiresAt,
  };
}
