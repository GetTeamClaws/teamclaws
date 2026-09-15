import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { helpText, parseArguments, run } from "../src/app.js";
import type { FetchLike } from "../src/http.js";
import { CredentialStore } from "../src/storage.js";
import {
  DEVICE_ID,
  fixture,
  jsonResponse,
  MemoryWritable,
  readyHandoff,
  SERVER_ID,
} from "./helpers.js";

const roots: string[] = [];
const NOW = Date.parse("2026-08-27T13:00:00.000Z");

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("capabilities command", () => {
  it.each([
    {
      failure: "missing",
      exitCode: 3,
      code: "re_pair_required",
      requests: 0,
      retryable: false,
    },
    {
      failure: "401",
      exitCode: 3,
      code: "capabilities_denied",
      requests: 1,
      retryable: false,
    },
    {
      failure: "403",
      exitCode: 3,
      code: "capabilities_denied",
      requests: 1,
      retryable: false,
    },
    {
      failure: "503",
      exitCode: 5,
      code: "capabilities_unavailable",
      requests: 1,
      retryable: true,
    },
    {
      failure: "network",
      exitCode: 5,
      code: "capabilities_unavailable",
      requests: 1,
      retryable: true,
    },
  ])(
    "returns a safe JSON error for $failure without rejecting",
    async ({ failure, exitCode, code, requests, retryable }) => {
      const store = new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      });
      if (failure !== "missing") {
        await store.writeWorkspace({
          version: 1,
          server_id: SERVER_ID,
          origin: "https://workspace.example.com",
          display_name: "Example",
          device_id: DEVICE_ID,
          device_token: "workspace-secret-token",
          created_at: "2026-09-05T00:00:00Z",
        });
      }
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const fetcher = vi.fn(async () => {
        if (failure === "network" || failure === "503") elapsed = 120_000;
        if (failure === "network") throw new Error("workspace-secret-token");
        return jsonResponse(
          {
            error: {
              code: "workspace-secret-token",
              message: `Bearer ${DEVICE_ID}:workspace-secret-token`,
              retryable: true,
            },
          },
          Number(failure),
        );
      });
      const stdout = new MemoryWritable();
      const stderr = new MemoryWritable();
      await expect(
        run(["chat", "capabilities", SERVER_ID, "--json"], {
          store,
          fetcher,
          io: { stdout, stderr },
        }),
      ).resolves.toBe(exitCode);
      expect(fetcher).toHaveBeenCalledTimes(requests);
      expect(stdout.value.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(stdout.value)).toEqual({
        schema_version: 1,
        event: "error",
        status: "error",
        code,
        message: expect.any(String),
        retryable,
      });
      expect(stderr.value).toBe("");
      expect(stdout.value + stderr.value).not.toContain(
        "workspace-secret-token",
      );
      expect(stdout.value + stderr.value).not.toContain(DEVICE_ID);
      expect(stdout.value + stderr.value).not.toContain("Bearer");
    },
  );

  it("requires an explicit target and rejects extra arguments", () => {
    expect(
      parseArguments(["chat", "capabilities", SERVER_ID, "--json"]),
    ).toEqual({ action: "chat_capabilities", target: SERVER_ID, json: true });
    expect(() => parseArguments(["chat", "capabilities"])).toThrow();
    expect(() =>
      parseArguments(["chat", "capabilities", SERVER_ID, "extra"]),
    ).toThrow();
    expect(helpText()).toContain(
      "teamclaws chat capabilities <target> [--json]",
    );
  });

  it("dispatches with no login or pairing preflight", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeWorkspace({
      version: 1,
      server_id: SERVER_ID,
      origin: "https://workspace.example.com",
      display_name: "Example",
      device_id: DEVICE_ID,
      device_token: "workspace-secret-token",
      created_at: "2026-09-05T00:00:00Z",
    });
    const raw = await fixture("contracts/capabilities-v1-ready.json");
    const fetcher = vi.fn(async () => jsonResponse(raw));
    const stdout = new MemoryWritable();
    expect(
      await run(["chat", "capabilities", SERVER_ID, "--json"], {
        store,
        fetcher,
        io: { stdout, stderr: new MemoryWritable() },
      }),
    ).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(stdout.value).external_chat_capabilities.providers,
    ).not.toEqual([]);
  });
});

describe("chat command error contract", () => {
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const requestId = "33333333-3333-4333-8333-333333333333";

  async function pairedStore(): Promise<CredentialStore> {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeWorkspace({
      version: 1,
      server_id: SERVER_ID,
      origin: "https://workspace.example.com",
      display_name: "Example",
      device_id: DEVICE_ID,
      device_token: "workspace-secret-token",
      created_at: "2026-09-07T00:00:00Z",
    });
    return store;
  }

  const verifiedPairing = {
    paired_device: {
      id: DEVICE_ID,
      status: "active",
      display_name: "Example",
      scopes: [
        "external_chat:capabilities:read",
        "external_chat:sessions:create",
        "external_chat:sessions:write",
      ],
    },
    external_chat_handoff: readyHandoff(),
  };

  it.each([
    ["start", SERVER_ID, "--message", "Acceptance test"],
    [
      "send",
      SERVER_ID,
      "--session-id",
      sessionId,
      "--message",
      "Acceptance test",
    ],
    ["watch", SERVER_ID, "--session-id", sessionId, "--request-id", requestId],
  ])(
    "serializes invalid capabilities for %s without rejecting",
    async (...args) => {
      const responses = [
        jsonResponse(verifiedPairing),
        jsonResponse({ contract_version: 2 }),
      ];
      const fetcher = vi.fn(async () => responses.shift()!);
      const stdout = new MemoryWritable();
      const stderr = new MemoryWritable();
      await expect(
        run(["chat", ...args, "--json"], {
          store: await pairedStore(),
          fetcher,
          io: { stdout, stderr },
        }),
      ).resolves.toBe(9);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(JSON.parse(stdout.value)).toEqual({
        schema_version: 1,
        event: "error",
        status: "error",
        code: "invalid_external_chat_response",
        message: "The workspace returned an invalid external chat response.",
        retryable: false,
      });
      expect(stderr.value).toBe("");
    },
  );

  it("serializes interrupted monitoring without canceling the remote request", async () => {
    const controller = new AbortController();
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const write = stdout.write.bind(stdout);
    stdout.write = (chunk: string): boolean => {
      const result = write(chunk);
      if (JSON.parse(chunk).event === "request_status_changed")
        controller.abort();
      return result;
    };
    const responses = [
      jsonResponse(verifiedPairing),
      jsonResponse(await fixture("contracts/capabilities-v1-ready.json")),
      jsonResponse({
        request: {
          request_id: requestId,
          session_id: sessionId,
          status: "awaiting_approval",
          revision: 2,
          response_cursor: 0,
          owner_conversation_url:
            "https://workspace.example.com/teamclaws-admin/",
          response_messages: [],
          error: {},
        },
      }),
    ];
    const fetcher: FetchLike = vi.fn(async () => responses.shift()!);
    await expect(
      run(
        [
          "chat",
          "watch",
          SERVER_ID,
          "--session-id",
          sessionId,
          "--request-id",
          requestId,
          "--json",
        ],
        { store: await pairedStore(), fetcher, io: { stdout, stderr } },
        controller.signal,
      ),
    ).resolves.toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, options] of vi.mocked(fetcher).mock.calls) {
      expect(options?.method).toBe("GET");
    }
    expect(
      stdout.value
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1),
    ).toEqual({
      schema_version: 1,
      event: "error",
      status: "error",
      code: "cancelled",
      message: "Chat monitoring was cancelled.",
      retryable: false,
    });
    expect(stdout.value).not.toContain("workspace-secret-token");
    expect(stdout.value).not.toContain(DEVICE_ID);
    expect(stderr.value).toBe("");
  });
});

describe("command-line interface", () => {
  it("parses only the documented command surface", () => {
    expect(parseArguments(["login", "--json"])).toEqual({
      action: "login",
      json: true,
    });
    expect(parseArguments(["login", "user@example.com"])).toEqual({
      action: "login",
      json: false,
      email: "user@example.com",
    });
    expect(parseArguments(["auth", "status"])).toEqual({
      action: "auth_status",
      json: false,
    });
    expect(parseArguments(["pair", "abc", "--no-open"])).toEqual({
      action: "pair",
      json: false,
      target: "abc",
      noOpen: true,
    });
    expect(parseArguments(["pair", "status", SERVER_ID, "--json"])).toEqual({
      action: "pair_status",
      json: true,
      target: SERVER_ID,
    });
    expect(
      parseArguments([
        "chat",
        "start",
        "https://workspace.example.com/",
        "--message",
        "hello",
        "--fast",
      ]),
    ).toMatchObject({
      action: "chat_start",
      options: {
        target: { workspace_url: "https://workspace.example.com/" },
        message: "hello",
        fastMode: true,
      },
    });
    expect(
      parseArguments([
        "chat",
        "watch",
        SERVER_ID,
        "--session-id",
        "22222222-2222-4222-8222-222222222222",
        "--request-id",
        "33333333-3333-4333-8333-333333333333",
        "--known-revision",
        "4",
        "--after-response-message-id",
        "12",
      ]),
    ).toMatchObject({
      action: "chat_watch",
      options: { knownRevision: 4, responseCursor: 12 },
    });
    expect(() => parseArguments(["pair", "abc", "def"])).toThrow();
    expect(() => parseArguments(["pair", "status"])).toThrow();
    expect(() => parseArguments(["pair", "--profile", "admin"])).toThrow();
    expect(() =>
      parseArguments([
        "chat",
        "start",
        SERVER_ID,
        "--message",
        "hello",
        "--fast",
        "--no-fast",
      ]),
    ).toThrow();
  });

  it("prints deterministic help and version output", async () => {
    const stdout = new MemoryWritable();
    expect(await run(["--help"], { io: { stdout } })).toBe(0);
    expect(stdout.value).toBe(helpText());
    const version = new MemoryWritable();
    expect(await run(["--version"], { io: { stdout: version } })).toBe(0);
    expect(version.value).toBe("1.0.1\n");
  });

  it("returns a structured usage error instead of throwing", async () => {
    const stdout = new MemoryWritable();
    expect(await run(["unknown", "--json"], { io: { stdout } })).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({
      event: "error",
      code: "invalid_command",
    });
  });

  it("requires login or an explicit target for pairing", async () => {
    const stdout = new MemoryWritable();
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    expect(await run(["pair", "--json"], { store, io: { stdout } })).toBe(4);
    expect(JSON.parse(stdout.value)).toMatchObject({
      code: "login_or_server_required",
    });
  });

  it("rejects permission and profile flags", async () => {
    const stdout = new MemoryWritable();
    expect(
      await run(["pair", "--profile", "admin", "--json"], { io: { stdout } }),
    ).toBe(2);
    expect(stdout.value).not.toContain("admin");
  });

  it("reports public authentication status and signs out locally", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    const status = new MemoryWritable();
    expect(
      await run(["auth", "status", "--json"], {
        store,
        io: { stdout: status },
      }),
    ).toBe(0);
    expect(JSON.parse(status.value)).toMatchObject({
      event: "auth_status",
      status: "signed_out",
    });

    const logout = new MemoryWritable();
    expect(
      await run(["logout", "--json"], {
        store,
        io: { stdout: logout },
      }),
    ).toBe(0);
    expect(JSON.parse(logout.value)).toMatchObject({
      event: "logout_complete",
      status: "success",
    });
  });

  it("lists discovered workspaces for an authenticated account", async () => {
    const store = await signedInStore();
    const stdout = new MemoryWritable();
    const fetcher: FetchLike = vi.fn(async () =>
      jsonResponse(await fixture("contracts/servers.json")),
    );
    expect(
      await run(["servers", "list", "--json"], {
        fetcher,
        store,
        io: { stdout },
      }),
    ).toBe(0);
    expect(JSON.parse(stdout.value)).toMatchObject({
      event: "servers_list",
      status: "success",
    });
  });

  it("stops device polling on expired_token with a secret-safe exit code", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const store = new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      });
      const stdout = new MemoryWritable();
      const stderr = new MemoryWritable();
      const calls: Array<{ url: string; init?: RequestInit }> = [];
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
          return jsonResponse(
            {
              error: "expired_token",
              error_description: "private arbitrary server response detail",
              device_code: "secret-device-code",
              access_token: "secret-access-token",
              refresh_token: "secret-refresh-token",
              authorization: "Bearer secret-authorization-value",
            },
            400,
          );
        }
        throw new Error("unexpected request");
      });
      const result = run(["login", "--json"], {
        fetcher,
        store,
        openBrowser: async () => false,
        io: { stdout, stderr },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toBe(3);

      expect(
        calls.filter(({ url }) => url.endsWith("/o/device-authorization/")),
      ).toHaveLength(1);
      expect(calls.filter(({ url }) => url.endsWith("/o/token/"))).toHaveLength(
        1,
      );
      const events = stdout.value
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({
        schema_version: 1,
        event: "error",
        status: "error",
        code: "login_timeout",
        message: "CLI sign-in timed out after 10 minutes.",
        retryable: false,
      });
      expect(stderr.value).toBe("");
      expect(await store.readLogin()).toBeUndefined();
      for (const sensitive of [
        "secret-device-code",
        "secret-access-token",
        "secret-refresh-token",
        "secret-authorization-value",
        "private arbitrary server response detail",
      ]) {
        expect(stdout.value).not.toContain(sensitive);
        expect(stderr.value).not.toContain(sensitive);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes both tokens before servers and preserves the opaque bearer", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const store = new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      });
      await store.writeLogin({
        version: 1,
        token_type: "Bearer",
        access_token: "original-access-token",
        refresh_token: "original-refresh-token",
        expires_at: "2026-08-27T12:00:00.000Z",
      });
      const rotatedAccessToken =
        "opaque-access-token.jti-like-segment.not-a-jwt";
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
        if (String(url).endsWith("/api/cli/v1/servers/")) {
          return jsonResponse(await fixture("contracts/servers.json"));
        }
        throw new Error("unexpected request");
      });
      const stdout = new MemoryWritable();
      expect(
        await run(["servers", "list", "--json"], {
          fetcher,
          store,
          io: { stdout },
        }),
      ).toBe(0);

      expect(calls.map(({ url }) => url)).toEqual([
        "https://www.teamclaws.com/o/token/",
        "https://www.teamclaws.com/api/cli/v1/servers/",
      ]);
      const refreshForm = new URLSearchParams(String(calls[0]?.init?.body));
      expect(Object.fromEntries(refreshForm)).toEqual({
        grant_type: "refresh_token",
        refresh_token: "original-refresh-token",
        client_id: "teamclaws-cli",
        resource: "https://www.teamclaws.com/api/cli/v1",
      });
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
    } finally {
      now.mockRestore();
    }
  });

  it("pairs an explicit workspace without TeamClaws login", async () => {
    const pending = await fixture("contracts/pairing-pending.json");
    const responses = [
      jsonResponse(pending, 201),
      jsonResponse({
        status: "paired",
        device_id: DEVICE_ID,
        device_token: "workspace-secret-token",
        token_type: "Bearer",
      }),
      jsonResponse({
        paired_device: {
          id: DEVICE_ID,
          status: "active",
          display_name: "Example computer",
        },
        external_chat_handoff: readyHandoff(),
      }),
    ];
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    const stdout = new MemoryWritable();
    expect(
      await run(["pair", SERVER_ID, "--no-open", "--json"], {
        fetcher: vi.fn(async () => responses.shift()!),
        store,
        io: { stdout },
      }),
    ).toBe(0);
    expect(await store.readWorkspace(SERVER_ID)).toMatchObject({
      server_id: SERVER_ID,
      device_id: DEVICE_ID,
    });
    expect(stdout.value).not.toContain("workspace-secret-token");
  });

  it("reports a missing local pairing without making any network request", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    const fetcher: FetchLike = vi.fn();
    const stdout = new MemoryWritable();

    expect(
      await run(["pair", "status", SERVER_ID, "--json"], {
        fetcher,
        store,
        io: { stdout },
      }),
    ).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.value)).toEqual({
      schema_version: 1,
      event: "pairing_status",
      status: "not_paired",
    });
  });

  it("verifies an existing pairing once and stops before broker or chat calls", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeWorkspace(workspaceCredential());
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: FetchLike = vi.fn(async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return jsonResponse({
        paired_device: {
          id: DEVICE_ID,
          status: "active",
          display_name: "Verified computer",
        },
        external_chat_handoff: {
          skill_url:
            "https://workspace.example.com/teamclaws-admin/device-chat-client/SKILL.md",
        },
      });
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const stdout = new MemoryWritable();
    try {
      expect(
        await run(
          [
            "pair",
            "status",
            "https://workspace.example.com/teamclaws-admin/?ignored=no",
            "--json",
          ],
          { fetcher, store, io: { stdout } },
        ),
      ).toBe(2);
      expect(fetcher).not.toHaveBeenCalled();

      stdout.value = "";
      expect(
        await run(
          ["pair", "status", "https://workspace.example.com/", "--json"],
          { fetcher, store, io: { stdout } },
        ),
      ).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "https://workspace.example.com/teamclaws-admin/api/device-pairings/me/",
      );
      expect(calls[0]?.url).not.toContain("/api/cli/v1/pairing/start/");
      expect(calls[0]?.url).not.toContain("device-chat-client");
      expect(calls[0]?.url).not.toContain("/device-chat/v1/");
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(JSON.parse(stdout.value)).toEqual({
        schema_version: 1,
        event: "pairing_status",
        status: "paired",
        workspace: {
          server_id: SERVER_ID,
          origin: "https://workspace.example.com",
          display_name: "Verified computer",
        },
      });
      expect(stdout.value).not.toContain(DEVICE_ID);
      expect(stdout.value).not.toContain("workspace-secret-value");
    } finally {
      timeout.mockRestore();
    }
  });

  it("reports a rejected credential without changing or retrying it", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    const credential = workspaceCredential();
    await store.writeWorkspace(credential);
    const fetcher: FetchLike = vi.fn(async () =>
      jsonResponse(
        { code: "invalid_credential", detail: "private detail" },
        401,
      ),
    );
    const stdout = new MemoryWritable();

    expect(
      await run(["pair", "status", SERVER_ID, "--json"], {
        fetcher,
        store,
        io: { stdout },
      }),
    ).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.value)).toMatchObject({
      event: "pairing_status",
      status: "credential_rejected",
    });
    expect(await store.readWorkspace(SERVER_ID)).toEqual(credential);
    expect(stdout.value).not.toContain("private detail");
    expect(stdout.value).not.toContain("workspace-secret-value");
  });

  it("reports an unreachable workspace after one request without retrying", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeWorkspace(workspaceCredential());
    const fetcher: FetchLike = vi.fn(async () => {
      throw new Error("private network detail");
    });
    const stdout = new MemoryWritable();

    expect(
      await run(["pair", "status", SERVER_ID, "--json"], {
        fetcher,
        store,
        io: { stdout },
      }),
    ).toBe(5);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.value)).toMatchObject({
      event: "pairing_status",
      status: "unreachable",
    });
    expect(stdout.value).not.toContain("private network detail");
  });

  it("returns one safe status when local credential resolution fails", async () => {
    const store = {
      findWorkspace: vi.fn(async () => {
        throw new Error("private local storage detail");
      }),
    } as unknown as CredentialStore;
    const fetcher: FetchLike = vi.fn();
    const stdout = new MemoryWritable();

    expect(
      await run(["pair", "status", SERVER_ID, "--json"], {
        fetcher,
        store,
        io: { stdout },
      }),
    ).toBe(5);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.value)).toEqual({
      schema_version: 1,
      event: "pairing_status",
      status: "unreachable",
    });
    expect(stdout.value).not.toContain("private local storage detail");
  });

  it("fails closed when multiple discovery results cannot be selected interactively", async () => {
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    await store.writeLogin({
      version: 1,
      token_type: "Bearer",
      access_token: "existing-access-token",
      refresh_token: "existing-refresh-token",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    const server = (id: string) => ({
      id,
      alias: id,
      workspace_url: `https://${id.slice(0, 8)}.example.com/`,
      status: "running",
      pairing_ready: true,
    });
    const fetcher: FetchLike = vi.fn(async () =>
      jsonResponse({
        servers: [
          server("11111111-1111-4111-8111-111111111111"),
          server("22222222-2222-4222-8222-222222222222"),
        ],
      }),
    );
    const stdout = new MemoryWritable();
    expect(
      await run(["pair", "--json"], {
        fetcher,
        store,
        io: { stdout, interactive: false },
      }),
    ).toBe(4);
    expect(JSON.parse(stdout.value)).toMatchObject({
      code: "server_selection_required",
    });
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "teamclaws-app-test-"));
  roots.push(root);
  return join(root, "private");
}

async function signedInStore(): Promise<CredentialStore> {
  const store = new CredentialStore({
    root: await tempRoot(),
    platform: process.platform,
  });
  await store.writeLogin({
    version: 1,
    token_type: "Bearer",
    access_token: "existing-access-token",
    refresh_token: "existing-refresh-token",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  return store;
}

function workspaceCredential() {
  return {
    version: 1 as const,
    server_id: SERVER_ID,
    origin: "https://workspace.example.com",
    display_name: "Example computer",
    device_id: DEVICE_ID,
    device_token: "workspace-secret-value",
    created_at: "2026-08-27T13:00:00.000Z",
  };
}

describe("explicit empty start reasoning", () => {
  it("preserves empty reasoning and false fast while other empty options still fail", () => {
    expect(
      parseArguments([
        "chat",
        "start",
        SERVER_ID,
        "--message",
        "Hello",
        "--reasoning",
        "",
        "--no-fast",
      ]),
    ).toMatchObject({
      action: "chat_start",
      options: { reasoning: "", fastMode: false },
    });
    expect(() =>
      parseArguments(["chat", "start", SERVER_ID, "--message", ""]),
    ).toThrow();
    expect(() =>
      parseArguments([
        "chat",
        "start",
        SERVER_ID,
        "--message",
        "Hello",
        "--model",
        "",
      ]),
    ).toThrow();
  });
});
