import { describe, expect, it } from "vitest";

import { parseCapabilityInventory } from "../src/external-chat.js";
import { TeamClawsError } from "../src/errors.js";
import { Output } from "../src/output.js";
import { parsePendingPairing } from "../src/validation.js";
import { fixture, MemoryWritable, SERVER_ID, USER_ID } from "./helpers.js";

describe("capability output", () => {
  it.each(["ready", "empty"])(
    "renders %s inventory and respects effective fast policy",
    async (kind) => {
      const inventory = parseCapabilityInventory(
        await fixture(`contracts/capabilities-v1-${kind}.json`),
      );
      const stdout = new MemoryWritable();
      new Output(false, stdout).capabilityInventory(
        { server_id: SERVER_ID, origin: "https://workspace.example.com" },
        inventory,
      );
      if (kind === "ready") {
        expect(stdout.value).toContain(
          "codex/test-model — reasoning: low, medium, high; fast: unavailable",
        );
        expect(stdout.value).toContain("Recommended: codex/test-model.");
      } else
        expect(stdout.value).toContain(
          "No provider/model is currently available.",
        );
      expect(stdout.value).toContain("Generation time is not supplied");
      expect(stdout.value).not.toContain("test-identity-not-for-output");
    },
  );
});

describe("safe output", () => {
  it("matches the frozen login event", async () => {
    const stdout = new MemoryWritable();
    const output = new Output(true, stdout, new MemoryWritable());
    output.loginComplete({
      id: USER_ID,
      display_name: "Example User",
      email: "user@example.com",
    });
    expect(JSON.parse(stdout.value)).toEqual(
      await fixture("output/login-complete.json"),
    );
  });

  it("matches the frozen pairing events", async () => {
    const stdout = new MemoryWritable();
    const output = new Output(true, stdout, new MemoryWritable());
    const url =
      "https://workspace.example.com/teamclaws-admin/device-pairings/33333333-3333-4333-8333-333333333333/";
    const pending = parsePendingPairing(
      await fixture("contracts/pairing-pending.json"),
    );
    output.pairingBrowser(url, "ABCD-EFGH", pending.agent_action);
    output.pairingComplete(
      SERVER_ID,
      "https://workspace.example.com",
      "Example computer",
    );
    const events = stdout.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      await fixture("output/pairing-browser-required.json"),
      await fixture("output/pairing-complete.json"),
    ]);
  });

  it("prints the server-rendered deliver-and-stop message without secrets", async () => {
    const stdout = new MemoryWritable();
    const pending = parsePendingPairing(
      await fixture("contracts/pairing-pending.json"),
    );
    new Output(false, stdout, new MemoryWritable()).pairingBrowser(
      pending.verification_uri_complete,
      pending.user_code,
      pending.agent_action,
    );
    expect(stdout.value).toBe(`${pending.agent_action?.message_markdown}\n`);
    expect(stdout.value).not.toContain(pending.device_code);
  });

  it("keeps structured errors on standard output and human errors on standard error", () => {
    const jsonOut = new MemoryWritable();
    const jsonErr = new MemoryWritable();
    new Output(true, jsonOut, jsonErr).error(
      new TeamClawsError("rate_limited", "Try again later.", {
        retryable: true,
        retryAfterSeconds: 30,
      }),
    );
    expect(JSON.parse(jsonOut.value)).toMatchObject({
      event: "error",
      code: "rate_limited",
      retry_after_seconds: 30,
    });
    expect(jsonErr.value).toBe("");

    const humanOut = new MemoryWritable();
    const humanErr = new MemoryWritable();
    new Output(false, humanOut, humanErr).error(
      new TeamClawsError("failed", "Safe failure."),
    );
    expect(humanOut.value).toBe("");
    expect(humanErr.value).toBe("Error: Safe failure.\n");
  });

  it("never serializes secret-bearing properties from an error", () => {
    const stdout = new MemoryWritable();
    const error = new TeamClawsError(
      "failed",
      "Safe failure.",
    ) as TeamClawsError & {
      access_token: string;
      device_code: string;
    };
    error.access_token = "do-not-print-access-token";
    error.device_code = "do-not-print-device-code";
    new Output(true, stdout, new MemoryWritable()).error(error);
    expect(stdout.value).not.toContain("do-not-print");
  });

  it("emits one safe terminal pairing-status event", () => {
    const stdout = new MemoryWritable();
    const output = new Output(true, stdout, new MemoryWritable());
    output.pairingStatus("paired", {
      server_id: SERVER_ID,
      origin: "https://workspace.example.com",
      display_name: "Example computer",
    });

    expect(stdout.value.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout.value)).toEqual({
      schema_version: 1,
      event: "pairing_status",
      status: "paired",
      workspace: {
        server_id: SERVER_ID,
        origin: "https://workspace.example.com",
        display_name: "Example computer",
      },
    });
  });

  it("renders every human-readable terminal state without structured data", () => {
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const output = new Output(false, stdout, stderr);
    const loginUrl = "https://www.teamclaws.com/o/device/?user_code=ABCD-EFGH";
    output.loginBrowser(loginUrl);
    output.authStatus("signed_out");
    output.authStatus(
      "signed_in",
      { id: USER_ID, display_name: "Example User", email: "user@example.com" },
      "2026-08-27T14:00:00.000Z",
    );
    output.logoutComplete(true);
    output.logoutComplete(false);
    output.servers([]);
    output.servers([
      {
        server_id: SERVER_ID,
        alias: "Example",
        workspace_url: "https://workspace.example.com/",
        status: "running",
        pairing_ready: true,
      },
    ]);
    expect(stdout.value.split("\n")[0]).toBe(loginUrl);
    expect(stdout.value).toContain("Not signed in");
    expect(stdout.value).toContain("Signed in as Example User");
    expect(stdout.value).toContain("could not confirm remote revocation");
    expect(stdout.value).toContain(SERVER_ID);
    expect(stdout.value).not.toContain("schema_version");
    expect(stderr.value).toBe("");
  });
});

describe("manual unusable recommendation", () => {
  it("keeps stale JSON metadata while rendering a useful human message", async () => {
    const inventory = parseCapabilityInventory(
      await fixture("contracts/capabilities-v1-ready.json"),
    );
    inventory.recommended_selection = {
      provider_key: "gone",
      model_name: "gone",
      reasoning_effort: "",
      fast_mode: false,
    };
    const before = structuredClone(inventory);
    const workspace = {
      server_id: SERVER_ID,
      origin: "https://workspace.example.com",
    };
    const human = new MemoryWritable();
    new Output(false, human).capabilityInventory(workspace, inventory);
    expect(human.value).toContain("No usable recommendation.");
    expect(human.value).toContain("codex/test-model");
    const json = new MemoryWritable();
    new Output(true, json).capabilityInventory(workspace, inventory);
    expect(JSON.parse(json.value).external_chat_capabilities).toEqual(before);
    expect(inventory).toEqual(before);
  });
});
