import { describe, expect, it, vi } from "vitest";

import {
  BrokerClient,
  normalizedDeviceName,
  pairingStartRequest,
} from "../src/broker.js";
import type { FetchLike } from "../src/http.js";
import { fixture, jsonResponse, SERVER_ID } from "./helpers.js";

describe("TeamClaws broker client", () => {
  it("builds only the locked pairing-start fields", () => {
    const request = pairingStartRequest(
      { server_id: SERVER_ID },
      "Example computer",
    );
    expect(Object.keys(request)).toEqual([
      "contract_version",
      "target",
      "request_id",
      "device_name",
      "client_name",
      "client_version",
    ]);
    expect(request).toMatchObject({
      contract_version: 1,
      target: { server_id: SERVER_ID },
      device_name: "Example computer",
      client_name: "teamclaws-cli",
      client_version: "1.0.1",
    });
    const serialized = JSON.stringify(request);
    for (const forbidden of [
      "requested_scopes",
      "capabilities",
      "profile",
      "role",
      "user_type",
      "public_key",
      "harness_name",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("matches the live server-identifier and workspace-address request contracts", async () => {
    const serverRequest = pairingStartRequest(
      { server_id: SERVER_ID },
      "Example computer",
    );
    serverRequest.request_id = "22222222-2222-4222-8222-222222222222";
    expect(serverRequest).toEqual(
      await fixture("contracts/pairing-start-server-id.json"),
    );

    const workspaceRequest = pairingStartRequest(
      { workspace_url: "https://workspace.example.com/" },
      "Example computer",
    );
    workspaceRequest.request_id = "22222222-2222-4222-8222-222222222222";
    expect(workspaceRequest).toEqual(
      await fixture("contracts/pairing-start-workspace-url.json"),
    );
  });

  it("normalizes a bounded computer label", () => {
    expect(normalizedDeviceName("  My   computer  ")).toBe("My computer");
    expect(normalizedDeviceName(" ")).toBe("Unnamed computer");
    expect(normalizedDeviceName("x".repeat(200))).toHaveLength(120);
  });

  it("sends optional login only in the Authorization header", async () => {
    const pending = await fixture("contracts/pairing-pending.json");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: FetchLike = vi.fn(async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return jsonResponse(pending, 201);
    });
    const broker = new BrokerClient({
      fetcher,
      deviceName: () => "Example computer",
    });
    await broker.startPairing({ server_id: SERVER_ID }, "login-secret");
    expect(calls[0]?.url).toBe(
      "https://www.teamclaws.com/api/cli/v1/pairing/start/",
    );
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer login-secret");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(body)).not.toContain("login-secret");
    expect(body).not.toHaveProperty("harness_name");
  });

  it("rejects a broker response for a different requested server", async () => {
    const pending = (await fixture("contracts/pairing-pending.json")) as Record<
      string,
      unknown
    >;
    pending.server_id = "66666666-6666-4666-8666-666666666666";
    const fetcher: FetchLike = vi.fn(async () => jsonResponse(pending, 201));
    const broker = new BrokerClient({ fetcher });
    await expect(
      broker.startPairing({ server_id: SERVER_ID }),
    ).rejects.toMatchObject({
      code: "target_mismatch",
    });
  });

  it("rejects a broker response for a different requested workspace address", async () => {
    const pending = await fixture("contracts/pairing-pending.json");
    const fetcher: FetchLike = vi.fn(async () => jsonResponse(pending, 201));
    const broker = new BrokerClient({ fetcher });
    await expect(
      broker.startPairing({ workspace_url: "https://other.example.com/" }),
    ).rejects.toMatchObject({
      code: "target_mismatch",
    });
  });

  it("parses authenticated discovery and fails closed on authentication errors", async () => {
    const servers = await fixture("contracts/servers.json");
    const success: FetchLike = vi.fn(async () => jsonResponse(servers));
    await expect(
      new BrokerClient({ fetcher: success }).servers("login-secret"),
    ).resolves.toHaveLength(1);

    const unauthorized: FetchLike = vi.fn(async () =>
      jsonResponse({ code: "invalid" }, 401),
    );
    await expect(
      new BrokerClient({ fetcher: unauthorized }).servers("bad"),
    ).rejects.toMatchObject({ code: "invalid_authentication" });
  });
});
