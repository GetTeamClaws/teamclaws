import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/http.js";
import { Output } from "../src/output.js";
import { PairingClient } from "../src/pairing.js";
import { CredentialStore } from "../src/storage.js";
import type { PendingPairing } from "../src/types.js";
import {
  DEVICE_ID,
  fixture,
  jsonResponse,
  MemoryWritable,
  readyHandoff,
  SERVER_ID,
} from "./helpers.js";
import { parsePendingPairing } from "../src/validation.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("optional pairing capability snapshot", () => {
  it.each([
    "ready",
    "empty",
    "null",
    "legacy",
    "malformed",
    "unknown-version",
    "bad-time",
  ])(
    "consumes %s without extra requests or credential storage changes",
    async (kind) => {
      const raw = await fixture(
        `contracts/capabilities-v1-${kind === "empty" ? "empty" : "ready"}.json`,
      );
      const timestamp = "2026-09-05T05:00:00.123456+00:00";
      const fields =
        kind === "legacy"
          ? {}
          : {
              external_chat_capabilities:
                kind === "null"
                  ? null
                  : kind === "malformed"
                    ? { credential: "secret-sentinel" }
                    : kind === "unknown-version"
                      ? { contract_version: 2 }
                      : raw,
              external_chat_capabilities_generated_at:
                kind === "null"
                  ? null
                  : kind === "bad-time"
                    ? "secret-sentinel"
                    : timestamp,
            };
      const responses = [
        jsonResponse({
          status: "paired",
          token_type: "Bearer",
          device_id: DEVICE_ID,
          device_token: "workspace-secret-token",
          ...fields,
        }),
        jsonResponse({
          paired_device: {
            id: DEVICE_ID,
            status: "active",
            display_name: "Example",
          },
          external_chat_handoff: readyHandoff(),
        }),
      ];
      const fetcher = vi.fn(async () => responses.shift()!);
      const store = new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      });
      const stdout = new MemoryWritable();
      const client = new PairingClient({
        store,
        fetcher,
        output: new Output(true, stdout),
      });
      await client.complete(await pendingFixture(), "Example", true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      const event = JSON.parse(stdout.value.trim().split("\n").at(-1)!);
      expect(event.event).toBe("pairing_complete");
      if (kind === "legacy")
        expect(event).not.toHaveProperty("external_chat_capabilities");
      else if (kind === "ready" || kind === "empty") {
        expect(event.external_chat_capabilities.providers).toHaveLength(
          kind === "ready" ? 1 : 0,
        );
        expect(event.external_chat_capabilities_generated_at).toBe(timestamp);
        if (kind === "empty")
          expect(
            event.external_chat_capabilities.recommended_selection,
          ).toBeNull();
      } else {
        expect(event.external_chat_capabilities).toBeNull();
        expect(event.external_chat_capabilities_generated_at).toBeNull();
      }
      expect(await store.readWorkspace(SERVER_ID)).not.toHaveProperty(
        "external_chat_capabilities",
      );
      expect(
        await readFile(store.workspacePath(SERVER_ID), "utf8"),
      ).not.toContain("external_chat_capabilities");
      for (const secret of [
        "workspace-secret-token",
        DEVICE_ID,
        "secret-sentinel",
        "test-identity-not-for-output",
      ])
        expect(stdout.value).not.toContain(secret);
    },
  );
});

describe("direct target pairing", () => {
  it("polls, stores, and verifies directly without sending the login bearer", async () => {
    const pending = await pendingFixture();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      jsonResponse({ status: "authorization_pending", interval: 1 }, 202),
      jsonResponse({
        status: "paired",
        device_id: DEVICE_ID,
        device_token: "workspace-secret-token",
        token_type: "Bearer",
        scopes: ["ignored"],
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
    const fetcher: FetchLike = vi.fn(async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return responses.shift()!;
    });
    const root = await tempRoot();
    const store = new CredentialStore({ root, platform: process.platform });
    const stdout = new MemoryWritable();
    const client = new PairingClient({
      fetcher,
      store,
      output: new Output(true, stdout, new MemoryWritable()),
      openBrowser: vi.fn(async () => true),
      wait: vi.fn(async () => undefined),
      now: () => Date.parse("2026-08-27T13:00:00.000Z"),
    });
    await client.complete(pending, "Example computer", false);

    expect(calls.map((call) => call.url)).toEqual([
      "https://workspace.example.com/teamclaws-admin/api/device-pairings/token/",
      "https://workspace.example.com/teamclaws-admin/api/device-pairings/token/",
      "https://workspace.example.com/teamclaws-admin/api/device-pairings/me/",
    ]);
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(
      false,
    );
    expect(new Headers(calls[2]?.init?.headers).get("authorization")).toBe(
      `Bearer ${DEVICE_ID}:workspace-secret-token`,
    );
    const stored = await store.readWorkspace(SERVER_ID);
    expect(stored).toMatchObject({
      server_id: SERVER_ID,
      origin: "https://workspace.example.com",
      display_name: "Example computer",
      device_id: DEVICE_ID,
    });
    expect(stdout.value).not.toContain("workspace-secret-token");
    expect(stdout.value).not.toContain("<redacted>");
    expect(stdout.value).not.toContain(DEVICE_ID);
    expect(
      await readFile(store.workspacePath(SERVER_ID), "utf8"),
    ).not.toContain(pending.device_code);
    expect(stdout.value.trim().split("\n")).toHaveLength(2);
  });

  it("does not open a browser when --no-open is selected", async () => {
    const pending = await pendingFixture();
    const openBrowser = vi.fn(async () => true);
    const fetcher = successfulPairingFetch();
    const client = new PairingClient({
      fetcher,
      store: new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      }),
      output: new Output(true, new MemoryWritable(), new MemoryWritable()),
      openBrowser,
      wait: vi.fn(async () => undefined),
    });
    await client.complete(pending, "Example", true);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("maps owner denial to the stable safe error", async () => {
    const pending = await pendingFixture();
    const fetcher: FetchLike = vi.fn(async () =>
      jsonResponse({ error: "Denied.", code: "denied" }, 403),
    );
    const client = new PairingClient({
      fetcher,
      store: new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      }),
      output: new Output(true, new MemoryWritable(), new MemoryWritable()),
      wait: vi.fn(async () => undefined),
    });
    await expect(
      client.complete(pending, "Example", true),
    ).rejects.toMatchObject({
      code: "pairing_denied",
      exitCode: 6,
    });
  });

  it("removes an unverified credential", async () => {
    const pending = await pendingFixture();
    const responses = [
      jsonResponse({
        status: "paired",
        device_id: DEVICE_ID,
        device_token: "workspace-secret-token",
        token_type: "Bearer",
        external_chat_capabilities: await fixture(
          "contracts/capabilities-v1-ready.json",
        ),
        external_chat_capabilities_generated_at: "2026-09-05T05:00:00Z",
      }),
      jsonResponse({ code: "invalid_credential", error: "Invalid." }, 401),
    ];
    const fetcher: FetchLike = vi.fn(async () => responses.shift()!);
    const store = new CredentialStore({
      root: await tempRoot(),
      platform: process.platform,
    });
    const stdout = new MemoryWritable();
    const client = new PairingClient({
      fetcher,
      store,
      output: new Output(true, stdout, new MemoryWritable()),
    });
    await expect(
      client.complete(pending, "Example", true),
    ).rejects.toMatchObject({
      code: "credential_verification_failed",
    });
    expect(await store.readWorkspace(SERVER_ID)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stdout.value).not.toContain("pairing_complete");
    expect(stdout.value).not.toContain("external_chat_capabilities");
  });

  it("calls the returned cancellation path when interrupted", async () => {
    const pending = await pendingFixture();
    const calls: string[] = [];
    const fetcher: FetchLike = vi.fn(async (url) => {
      calls.push(String(url));
      return jsonResponse({ status: "cancelled" });
    });
    const controller = new AbortController();
    controller.abort();
    const client = new PairingClient({
      fetcher,
      store: new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      }),
      output: new Output(true, new MemoryWritable(), new MemoryWritable()),
    });
    await expect(
      client.complete(pending, "Example", true, controller.signal),
    ).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(calls).toEqual([
      "https://workspace.example.com/teamclaws-admin/api/device-pairings/cancel/",
    ]);
  });

  it("honors target slow-down timing before retrying", async () => {
    const pending = await pendingFixture();
    const waits: number[] = [];
    const responses = [
      jsonResponse({ code: "rate_limited", retry_after_seconds: 7 }, 429, {
        "Retry-After": "7",
      }),
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
          display_name: "Example",
        },
        external_chat_handoff: readyHandoff(),
      }),
    ];
    const client = new PairingClient({
      fetcher: vi.fn(async () => responses.shift()!),
      store: new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      }),
      output: new Output(true, new MemoryWritable(), new MemoryWritable()),
      wait: vi.fn(async (milliseconds) => {
        waits.push(milliseconds);
      }),
    });
    await client.complete(pending, "Example", true);
    expect(waits).toEqual([7_000]);
  });

  it("keeps the default polling timer referenced while the CLI waits", async () => {
    const pending = await pendingFixture();
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const client = new PairingClient({
      fetcher: vi.fn(async () =>
        jsonResponse({ status: "authorization_pending", interval: 3 }, 202),
      ),
      store: new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      }),
      output: new Output(true, new MemoryWritable(), new MemoryWritable()),
    });
    const completion = client.complete(
      pending,
      "Example",
      true,
      controller.signal,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      for (let attempt = 0; attempt < 20 && !timer; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const timerIndex = timeoutSpy.mock.calls.findIndex(
          (call) => call[1] === pending.interval * 1_000,
        );
        if (timerIndex >= 0) {
          timer = timeoutSpy.mock.results[timerIndex]?.value as ReturnType<
            typeof setTimeout
          >;
        }
      }
      expect(timer).toBeDefined();
      expect(timer?.hasRef()).toBe(true);
    } finally {
      controller.abort();
      await expect(completion).rejects.toMatchObject({ code: "cancelled" });
      timeoutSpy.mockRestore();
    }
  });

  it("expires after the target-owned deadline", async () => {
    const pending = { ...(await pendingFixture()), expires_in: 1 };
    let now = 0;
    const client = new PairingClient({
      fetcher: vi.fn(async () =>
        jsonResponse({ status: "authorization_pending", interval: 1 }, 202),
      ),
      store: new CredentialStore({
        root: await tempRoot(),
        platform: process.platform,
      }),
      output: new Output(true, new MemoryWritable(), new MemoryWritable()),
      now: () => now,
      wait: vi.fn(async (milliseconds) => {
        now += milliseconds;
      }),
    });
    await expect(
      client.complete(pending, "Example", true),
    ).rejects.toMatchObject({
      code: "pairing_expired",
      exitCode: 7,
    });
  });
});

async function pendingFixture(): Promise<PendingPairing> {
  return parsePendingPairing(await fixture("contracts/pairing-pending.json"));
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "teamclaws-pairing-test-"));
  roots.push(root);
  return join(root, "private");
}

function successfulPairingFetch(): FetchLike {
  const responses = [
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
  return vi.fn(async () => responses.shift()!);
}
