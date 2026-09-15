import { afterEach, expect, it, vi } from "vitest";
import { ExternalChatClient } from "../src/external-chat.js";
import type { CredentialStore } from "../src/storage.js";
import type { CapabilityInventory } from "../src/types.js";
import { Output } from "../src/output.js";
import {
  DEVICE_ID,
  SERVER_ID,
  fixture,
  jsonResponse,
  MemoryWritable,
} from "./helpers.js";

const target = { server_id: SERVER_ID };
const store = {
  findWorkspace: vi.fn(async () => ({
    version: 1,
    server_id: SERVER_ID,
    origin: "https://workspace.example.com",
    device_id: DEVICE_ID,
    device_token: "synthetic-token",
    display_name: "Test",
  })),
} as unknown as CredentialStore;
const output = new Output(true, new MemoryWritable());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  null,
  {
    provider_key: "stale",
    model_name: "missing",
    reasoning_effort: "",
    fast_mode: false,
  },
])(
  "returns nonempty inventory without recommendation applicability or declared scope gating: %j",
  async (recommendation) => {
    const raw = (await fixture(
      "contracts/capabilities-v1-ready.json",
    )) as CapabilityInventory;
    raw.recommended_selection = recommendation;
    raw.approved_scopes = [];
    const fetcher = vi.fn(async () => jsonResponse(raw));
    const result = await new ExternalChatClient({
      store,
      output,
      fetcher,
    }).listInventory(target);
    expect(result.external_chat_capabilities).toMatchObject({
      providers: raw.providers.map((p) => ({ id: p.id })),
      recommended_selection: recommendation,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-token");
  },
);

it.each([200, 408, 429, 500, 502, 503, 504])(
  "retries empty/transient %i then returns usable inventory",
  async (status) => {
    const empty = await fixture("contracts/capabilities-v1-empty.json");
    const ready = await fixture("contracts/capabilities-v1-ready.json");
    let time = 0;
    const wait = vi.fn(async (ms: number) => {
      time += ms;
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(empty, status))
      .mockResolvedValueOnce(jsonResponse(ready));
    await new ExternalChatClient({
      store,
      output,
      fetcher,
      wait,
      now: () => time,
    }).listInventory(target);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledExactlyOnceWith(5000, undefined);
  },
);

it("clips the last attempt and final wait to one deadline, then gives exhaustion guidance", async () => {
  const empty = await fixture("contracts/capabilities-v1-empty.json");
  let time = 0;
  const wait = vi.fn(async (ms: number) => {
    time += ms;
  });
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const fetcher = vi.fn(async () => {
    time += time === 0 ? 107_000 : 3_000;
    return jsonResponse(empty);
  });
  await expect(
    new ExternalChatClient({
      store,
      output,
      fetcher,
      wait,
      now: () => time,
    }).listInventory(target),
  ).rejects.toMatchObject({
    code: "capabilities_unavailable",
    message: expect.stringContaining(
      "Log into TeamClaws and ensure the server is running.",
    ),
  });
  expect(timeout.mock.calls.map((c) => c[0])).toEqual([
    15000, 15000, 8000, 8000,
  ]);
  expect(wait.mock.calls.map((c) => c[0])).toEqual([5000, 5000]);
  expect(time).toBe(120_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 400, 501])(
  "does not retry HTTP %i as empty",
  async (status) => {
    const fetcher = vi.fn(async () => jsonResponse({}, status));
    const wait = vi.fn();
    await expect(
      new ExternalChatClient({ store, output, fetcher, wait }).listInventory(
        target,
      ),
    ).rejects.toMatchObject({
      exitCode: status === 401 || status === 403 ? 3 : 5,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  },
);

it("does not retry a malformed contract", async () => {
  const fetcher = vi.fn(async () => jsonResponse({ providers: [] }));
  await expect(
    new ExternalChatClient({ store, output, fetcher }).listInventory(target),
  ).rejects.toMatchObject({ code: "invalid_external_chat_response" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("respects cancellation while waiting without a further fetch", async () => {
  const empty = await fixture("contracts/capabilities-v1-empty.json");
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetcher = vi.fn(async () => jsonResponse(empty));
  const result = new ExternalChatClient({
    store,
    output,
    fetcher,
  }).listInventory(target, controller.signal);
  const check = expect(result).rejects.toMatchObject({ code: "cancelled" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await check;
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "handles body-read timeout/cancellation (cancel=%s)",
  async (cancel) => {
    const ready = await fixture("contracts/capabilities-v1-ready.json");
    vi.useFakeTimers();
    const controller = new AbortController();
    let time = 0;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        const response = jsonResponse({});
        response.text = () =>
          new Promise((_resolve, reject) =>
            init.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            ),
          );
        return response;
      })
      .mockResolvedValueOnce(jsonResponse(ready));
    const result = new ExternalChatClient({
      store,
      output,
      fetcher,
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
    }).listInventory(target, controller.signal);
    const check = cancel
      ? expect(result).rejects.toMatchObject({ code: "cancelled" })
      : expect(result).resolves.toHaveProperty("external_chat_capabilities");
    // Node's native AbortSignal timeout is not controlled by Vitest timers.
    const abort = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(), ms);
      return c.signal;
    });
    await vi.advanceTimersByTimeAsync(1);
    if (cancel) controller.abort();
    else {
      time = 15000;
      await vi.advanceTimersByTimeAsync(15000);
    }
    await check;
    abort.mockRestore();
    expect(fetcher).toHaveBeenCalledTimes(cancel ? 1 : 2);
  },
);
