import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseCapabilityInventory,
  ExternalChatClient,
} from "../src/external-chat.js";
import type { FetchLike } from "../src/http.js";
import { Output } from "../src/output.js";
import { CredentialStore } from "../src/storage.js";
import {
  DEVICE_ID,
  fixture,
  jsonResponse,
  MemoryWritable,
  readyHandoff,
  SERVER_ID,
} from "./helpers.js";

const ORIGIN = "https://workspace.example.com";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const OWNER_URL = `${ORIGIN}/teamclaws-admin/tcchat?chat_public_id=77777777-7777-4777-8777-777777777777`;
const REQUIRED_SCOPES = [
  "external_chat:capabilities:read",
  "external_chat:sessions:create",
  "external_chat:sessions:write",
];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("capability discovery", () => {
  it.each(["ready"])(
    "reads %s inventory with one authenticated GET and no preflight",
    async (kind) => {
      const raw = await fixture(`contracts/capabilities-v1-${kind}.json`);
      const fetcher = vi.fn(async () => jsonResponse(raw));
      const stdout = new MemoryWritable();
      const client = new ExternalChatClient({
        ...inventoryClock(),
        store: await pairedStore(),
        fetcher,
        output: new Output(true, stdout),
      });
      await expect(client.capabilities({ server_id: SERVER_ID })).resolves.toBe(
        0,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = (
        fetcher.mock.calls as unknown as Array<[string, RequestInit]>
      )[0]!;
      expect(url).toBe(
        `${ORIGIN}/teamclaws-admin/api/device-chat/v1/capabilities/`,
      );
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Bearer ${DEVICE_ID}:workspace-secret-token`,
      );
      expect(JSON.parse(stdout.value)).toMatchObject({
        schema_version: 1,
        event: "chat_capabilities",
        source: "refresh",
        status: "success",
        workspace: { server_id: SERVER_ID, origin: ORIGIN },
        external_chat_capabilities: parseCapabilityInventory(raw),
      });
      expect(stdout.value.trim().split("\n")).toHaveLength(1);
      expect(stdout.value).not.toContain("workspace-secret-token");
      expect(stdout.value).not.toContain("test-identity-not-for-output");
    },
  );

  it("needs only capability-read scope and strips unknown fields", () => {
    const raw = {
      ...capabilities(),
      approved_scopes: ["external_chat:capabilities:read"],
      credential: "secret-sentinel",
      identity: { alias: "Guest", id: "secret-sentinel" },
    };
    const parsed = parseCapabilityInventory(raw);
    expect(parsed.approved_scopes).toEqual(["external_chat:capabilities:read"]);
    expect(parsed.providers[0]?.models[0]?.supported_reasoning_levels).toEqual([
      "medium",
      "high",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("secret-sentinel");
    expect(
      parseCapabilityInventory({ ...raw, recommended_selection: null })
        .recommended_selection,
    ).toBeNull();
  });

  it.each([
    null,
    {},
    { contract_version: 2 },
    { ...capabilities(), providers: null },
    { ...capabilities(), providers: Array(33).fill({}) },
    { ...capabilities(), limits: {} },
  ])("rejects malformed inventory", (raw) => {
    expect(() => parseCapabilityInventory(raw)).toThrow();
  });

  it.each([401, 403, 404, 429, 500, 503])(
    "handles HTTP %i with bounded transient retries and safe errors",
    async (status) => {
      const fetcher = vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "workspace-secret-token",
              message: "workspace-secret-token",
              retryable: true,
            },
          },
          status,
        ),
      );
      const client = new ExternalChatClient({
        ...inventoryClock(),
        store: await pairedStore(),
        fetcher,
        output: new Output(true, new MemoryWritable()),
      });
      await expect(
        client.capabilities({ server_id: SERVER_ID }),
      ).rejects.toMatchObject({
        exitCode: status === 401 || status === 403 ? 3 : 5,
        message: expect.not.stringContaining("workspace-secret-token"),
      });
      expect(fetcher).toHaveBeenCalledTimes(
        status === 429 || status >= 500 ? 24 : 1,
      );
    },
  );

  it("does not fetch without saved credentials", async () => {
    const store = await pairedStore();
    await store.removeWorkspace(SERVER_ID);
    const fetcher = vi.fn();
    const client = new ExternalChatClient({
      ...inventoryClock(),
      store,
      fetcher,
      output: new Output(true, new MemoryWritable()),
    });
    await expect(
      client.capabilities({ server_id: SERVER_ID }),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries failed connections within the inventory budget", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn(async () => {
      throw new Error("secret-sentinel");
    });
    const client = new ExternalChatClient({
      ...inventoryClock(),
      store: await pairedStore(),
      fetcher,
      output: new Output(true, new MemoryWritable()),
    });
    await expect(
      client.capabilities({ server_id: SERVER_ID }),
    ).rejects.toMatchObject({ code: "capabilities_unavailable", exitCode: 5 });
    expect(timeout).toHaveBeenCalledWith(15000);
    expect(fetcher).toHaveBeenCalledTimes(24);
    timeout.mockRestore();
  });

  it("terminates an aborted request without retry", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    const client = new ExternalChatClient({
      ...inventoryClock(),
      store: await pairedStore(),
      fetcher,
      output: new Output(true, new MemoryWritable()),
    });
    await expect(
      client.capabilities({ server_id: SERVER_ID }, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("native external chat", () => {
  it("does not start a chat from a valid empty inventory", async () => {
    const empty = await fixture("contracts/capabilities-v1-empty.json");
    const responses = [jsonResponse(verifiedPairing()), jsonResponse(empty)];
    const fetcher = vi.fn(async () => responses.shift() ?? jsonResponse(empty));
    const client = new ExternalChatClient({
      ...inventoryClock(),
      store: await pairedStore(),
      fetcher,
      output: new Output(true, new MemoryWritable()),
    });
    await expect(
      client.start({ target: { server_id: SERVER_ID }, message: "No chat" }),
    ).rejects.toMatchObject({ code: "capabilities_unavailable", exitCode: 5 });
    expect(fetcher).toHaveBeenCalledTimes(25);
  });

  it("creates the first turn directly and emits each durable response once", async () => {
    const store = await pairedStore();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      jsonResponse(verifiedPairing()),
      jsonResponse(capabilities()),
      jsonResponse(
        {
          session: {
            session_id: SESSION_ID,
            owner_conversation_url: OWNER_URL,
          },
          initial_message_request: requestState("queued", 1),
        },
        201,
      ),
      jsonResponse({ request: requestState("running", 2) }),
      jsonResponse({
        request: requestState("succeeded", 3, [
          {
            id: 41,
            body_text: "Remote answer",
            provider_key: "codex",
            model_name: "gpt-5.5",
          },
        ]),
      }),
    ];
    const fetcher: FetchLike = vi.fn(async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    const stdout = new MemoryWritable();
    const client = new ExternalChatClient({
      store,
      fetcher,
      output: new Output(true, stdout),
      wait: vi.fn(async () => undefined),
    });

    await expect(
      client.start({
        target: { workspace_url: `${ORIGIN}/` },
        message: "Hello from the CLI",
        clientRequestId: CLIENT_REQUEST_ID,
      }),
    ).resolves.toBe(0);

    expect(calls.map(({ url }) => url)).toEqual([
      `${ORIGIN}/teamclaws-admin/api/device-pairings/me/`,
      `${ORIGIN}/teamclaws-admin/api/device-chat/v1/capabilities/`,
      `${ORIGIN}/teamclaws-admin/api/device-chat/v1/sessions/`,
      `${ORIGIN}/teamclaws-admin/api/device-chat/v1/requests/${REQUEST_ID}/?known_revision=1&after_response_message_id=0`,
      `${ORIGIN}/teamclaws-admin/api/device-chat/v1/requests/${REQUEST_ID}/?known_revision=2&after_response_message_id=0`,
    ]);
    expect(JSON.parse(String(calls[2]!.init!.body))).toEqual({
      client_request_id: CLIENT_REQUEST_ID,
      provider_key: "codex",
      model_name: "gpt-5.5",
      reasoning_effort: "medium",
      fast_mode: true,
      initial_message: "Hello from the CLI",
    });
    expect(new Headers(calls[2]!.init!.headers).get("authorization")).toBe(
      `Bearer ${DEVICE_ID}:workspace-secret-token`,
    );
    expect(
      stdout.value
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
    ).toEqual([
      "capabilities_resolved",
      "session_created",
      "request_status_changed",
      "request_status_changed",
      "request_status_changed",
      "assistant_message",
      "request_succeeded",
    ]);
    expect(stdout.value.match(/Remote answer/gu)).toHaveLength(1);
    expect(stdout.value).not.toContain("workspace-secret-token");
    expect(stdout.value).not.toContain("device-chat-client");
  });

  it.each(["ready", "empty", "no recommendation"])(
    "resumes with %s inventory without creating a session or repeating approval",
    async (inventory) => {
      const store = await pairedStore();
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const responses = [
        jsonResponse(verifiedPairing()),
        jsonResponse(
          inventory === "empty"
            ? await fixture("contracts/capabilities-v1-empty.json")
            : {
                ...capabilities(),
                ...(inventory === "no recommendation"
                  ? { recommended_selection: null }
                  : {}),
              },
        ),
        jsonResponse({
          request: requestState("awaiting_approval", 5, [], 41),
        }),
        jsonResponse({
          request: requestState("succeeded", 6, [
            {
              id: 42,
              body_text: "Continued answer",
              provider_key: "codex",
              model_name: "gpt-5.5",
            },
          ]),
        }),
      ];
      const fetcher: FetchLike = vi.fn(async (url, init) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        return responses.shift()!;
      });
      const stdout = new MemoryWritable();
      const client = new ExternalChatClient({
        store,
        fetcher,
        output: new Output(true, stdout),
        wait: vi.fn(async () => undefined),
      });

      await expect(
        client.watch({
          target: { server_id: SERVER_ID },
          sessionId: SESSION_ID,
          requestId: REQUEST_ID,
          knownRevision: 5,
          responseCursor: 41,
        }),
      ).resolves.toBe(0);

      expect(calls.slice(2).every(({ init }) => init?.method !== "POST")).toBe(
        true,
      );
      expect(calls[2]!.url).toContain(
        "known_revision=5&after_response_message_id=41",
      );
      expect(stdout.value).not.toContain("approval_required");
      expect(stdout.value.match(/Continued answer/gu)).toHaveLength(1);
    },
  );

  it("continues an existing session with empty inventory without selecting a new runtime", async () => {
    const responses = [
      jsonResponse(verifiedPairing()),
      jsonResponse(await fixture("contracts/capabilities-v1-empty.json")),
      jsonResponse({
        request: requestState("succeeded", 7, [
          {
            id: 43,
            body_text: "Existing session answer",
            provider_key: "codex",
            model_name: "gpt-5.5",
          },
        ]),
      }),
    ];
    const fetcher: FetchLike = vi.fn(async () => responses.shift()!);
    const stdout = new MemoryWritable();
    const client = new ExternalChatClient({
      store: await pairedStore(),
      fetcher,
      output: new Output(true, stdout),
    });
    await expect(
      client.send({
        target: { server_id: SERVER_ID },
        sessionId: SESSION_ID,
        clientRequestId: CLIENT_REQUEST_ID,
        message: "Continue this session",
      }),
    ).resolves.toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(fetcher).mock.calls;
    expect(calls.slice(0, 2).every(([, init]) => init?.method === "GET")).toBe(
      true,
    );
    expect(calls[2]![0]).toBe(
      `${ORIGIN}/teamclaws-admin/api/device-chat/v1/sessions/${SESSION_ID}/messages/create/`,
    );
    expect(calls[2]![1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]![1]?.body))).toEqual({
      client_request_id: CLIENT_REQUEST_ID,
      body_text: "Continue this session",
    });
    expect(stdout.value).not.toContain("session_created");
    expect(stdout.value).not.toContain("capabilities_resolved");
    expect(stdout.value.match(/Existing session answer/gu)).toHaveLength(1);
    expect(stdout.value).toContain("request_succeeded");
    expect(stdout.value).not.toContain("workspace-secret-token");
  });

  it("stops before capability discovery when the pairing scopes are stale", async () => {
    const store = await pairedStore();
    const fetcher: FetchLike = vi.fn(async () =>
      jsonResponse(verifiedPairing(["external_chat:capabilities:read"])),
    );
    const stdout = new MemoryWritable();
    const client = new ExternalChatClient({
      store,
      fetcher,
      output: new Output(true, stdout),
    });

    await expect(
      client.start({
        target: { server_id: SERVER_ID },
        message: "Do not create a session",
      }),
    ).rejects.toMatchObject({ code: "re_pair_required", exitCode: 3 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(stdout.value).toBe("");
  });
});

async function pairedStore(): Promise<CredentialStore> {
  const root = await mkdtemp(join(tmpdir(), "teamclaws-chat-test-"));
  roots.push(root);
  const store = new CredentialStore({ root, platform: process.platform });
  await store.writeWorkspace({
    version: 1,
    server_id: SERVER_ID,
    origin: ORIGIN,
    display_name: "Paired computer",
    device_id: DEVICE_ID,
    device_token: "workspace-secret-token",
    created_at: "2026-09-04T00:00:00.000Z",
  });
  return store;
}

describe("start selection independent of recommendations", () => {
  it.each([
    {
      name: "null",
      rec: null,
      requested: { provider: "codex", model: "gpt-5.5" },
      reason: "",
      fast: true,
    },
    {
      name: "stale",
      rec: {
        provider_key: "gone",
        model_name: "gone",
        reasoning_effort: "bad",
        fast_mode: true,
      },
      requested: { provider: "codex", model: "gpt-5.5" },
      reason: "",
      fast: true,
    },
    {
      name: "explicit empty and false",
      rec: undefined,
      requested: {
        provider: "codex",
        model: "gpt-5.5",
        reasoning: "",
        fastMode: false,
      },
      reason: "",
      fast: false,
    },
    {
      name: "partial override",
      rec: undefined,
      requested: { provider: "codex" },
      reason: "medium",
      fast: true,
    },
    {
      name: "normal default",
      rec: undefined,
      requested: {},
      reason: "medium",
      fast: true,
    },
  ])(
    "preserves $name selection through the create body",
    async ({ rec, requested, reason, fast }) => {
      const raw = capabilities();
      if (rec !== undefined) raw.recommended_selection = rec;
      const responses = [
        jsonResponse(verifiedPairing()),
        jsonResponse(raw),
        jsonResponse({
          session: { session_id: SESSION_ID },
          initial_message_request: requestState("succeeded", 1, [
            {
              id: 1,
              body_text: "Answer",
              provider_key: "codex",
              model_name: "gpt-5.5",
            },
          ]),
        }),
      ];
      const fetcher = vi.fn(async () => responses.shift()!);
      const client = new ExternalChatClient({
        store: await pairedStore(),
        fetcher,
        output: new Output(true, new MemoryWritable()),
      });
      await expect(
        client.start({
          target: { server_id: SERVER_ID },
          message: "Hello",
          ...requested,
        }),
      ).resolves.toBe(0);
      const calls = fetcher.mock.calls as unknown as Array<
        [string, RequestInit]
      >;
      expect(calls).toHaveLength(3);
      expect(JSON.parse(String(calls[2]![1].body))).toMatchObject({
        provider_key: "codex",
        model_name: "gpt-5.5",
        reasoning_effort: reason,
        fast_mode: fast,
      });
    },
  );

  it.each([
    { provider: "missing", model: "gpt-5.5" },
    { provider: "codex", model: "gpt-5.5", reasoning: "unsupported" },
    { provider: "codex", model: "gpt-5.5", fastMode: true },
    { provider: "codex" },
  ])(
    "rejects incompatible or unresolved explicit choices before creation: %j",
    async (requested) => {
      const raw = {
        ...capabilities(),
        recommended_selection: null,
        policy: { allow_fast_mode: false },
      };
      const responses = [jsonResponse(verifiedPairing()), jsonResponse(raw)];
      const fetcher = vi.fn(async () => responses.shift()!);
      const client = new ExternalChatClient({
        store: await pairedStore(),
        fetcher,
        output: new Output(true, new MemoryWritable()),
      });
      await expect(
        client.start({
          target: { server_id: SERVER_ID },
          message: "Hello",
          ...requested,
        }),
      ).rejects.toMatchObject({ code: "selection_unavailable" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});

function verifiedPairing(scopes = REQUIRED_SCOPES): Record<string, unknown> {
  return {
    paired_device: {
      id: DEVICE_ID,
      status: "active",
      display_name: "Paired computer",
      scopes,
    },
    external_chat_handoff: readyHandoff(ORIGIN),
  };
}

function capabilities(): Record<string, unknown> {
  return {
    contract_version: 1,
    identity: { id: "external-identity", alias: "CLI guest" },
    approved_scopes: REQUIRED_SCOPES,
    recommended_selection: {
      provider_key: "codex",
      model_name: "gpt-5.5",
      reasoning_effort: "medium",
      fast_mode: true,
    },
    policy: { allow_fast_mode: true },
    limits: { message_chars: 12_000, recommended_poll_seconds: 1 },
    providers: [
      {
        id: "codex",
        models: [
          {
            id: "gpt-5.5",
            supported_reasoning_levels: ["medium", "high"],
            fast_mode_available: true,
          },
        ],
      },
    ],
  };
}

function requestState(
  status: string,
  revision: number,
  responseMessages: unknown[] = [],
  knownResponseCursor = 0,
): Record<string, unknown> {
  const responseCursor = Math.max(
    knownResponseCursor,
    ...responseMessages.map((message) =>
      typeof message === "object" && message !== null && "id" in message
        ? Number(message.id)
        : 0,
    ),
  );
  return {
    request_id: REQUEST_ID,
    session_id: SESSION_ID,
    status,
    revision,
    response_cursor: responseCursor,
    owner_conversation_url: OWNER_URL,
    response_messages: responseMessages,
    error: {},
  };
}

function inventoryClock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (milliseconds: number) => {
      time += milliseconds;
    },
  };
}
