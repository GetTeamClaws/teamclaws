import { describe, expect, it } from "vitest";

import { TeamClawsError } from "../src/errors.js";
import {
  canonicalWorkspaceUrl,
  directTargetUrl,
  parseExternalChatHandoff,
  parsePairingCredential,
  parsePairingTarget,
  parsePendingPairing,
  parseSafeUserResponse,
  parseServersResponse,
  parseVerifiedDevice,
  validateDirectTarget,
} from "../src/validation.js";
import { DEVICE_ID, fixture, readyHandoff, SERVER_ID } from "./helpers.js";

describe("strict contract validation", () => {
  it("parses the locked server identifier and canonical address target forms", () => {
    expect(parsePairingTarget(SERVER_ID.toUpperCase())).toEqual({
      server_id: SERVER_ID,
    });
    expect(parsePairingTarget("https://workspace.example.com/")).toEqual({
      workspace_url: "https://workspace.example.com/",
    });
    expect(parsePairingTarget("https://workspace.example.com")).toEqual({
      workspace_url: "https://workspace.example.com/",
    });
  });

  it.each([
    "http://workspace.example.com",
    "https://user@workspace.example.com",
    "https://workspace.example.com/path",
    "https://workspace.example.com?query=1",
    "https://127.0.0.1",
    "https://localhost",
  ])("rejects unsafe workspace addresses: %s", (value) => {
    expect(() => canonicalWorkspaceUrl(value)).toThrow(TeamClawsError);
  });

  it("accepts the exact grouped direct target and builds same-origin addresses", () => {
    const target = validateDirectTarget({
      origin: "https://workspace.example.com",
      token_poll_path: "/teamclaws-admin/api/device-pairings/token/",
      cancellation_path: "/teamclaws-admin/api/device-pairings/cancel/",
      credential_verification_path: "/teamclaws-admin/api/device-pairings/me/",
    });
    expect(directTargetUrl(target, target.token_poll_path)).toBe(
      "https://workspace.example.com/teamclaws-admin/api/device-pairings/token/",
    );
  });

  it.each([
    "//attacker.example/x",
    "/safe?redirect=x",
    "/a/../b",
    "https://attacker.example/x",
  ])("rejects unsafe direct target paths: %s", (path) => {
    expect(() =>
      validateDirectTarget({
        origin: "https://workspace.example.com",
        token_poll_path: path,
        cancellation_path: "/cancel/",
        credential_verification_path: "/me/",
      }),
    ).toThrow(TeamClawsError);
  });

  it("rejects unknown fields inside the grouped target", () => {
    expect(() =>
      validateDirectTarget({
        origin: "https://workspace.example.com",
        token_poll_path: "/token/",
        cancellation_path: "/cancel/",
        credential_verification_path: "/me/",
        token_poll_url: "https://attacker.example/token/",
      }),
    ).toThrow(/invalid target/u);
  });

  it("parses the frozen pending fixture", async () => {
    const response = (await fixture(
      "contracts/pairing-pending.json",
    )) as Record<string, unknown>;
    const pending = parsePendingPairing(response);
    expect(pending.server_id).toBe(SERVER_ID);
    expect(pending.device_code).toBe("<redacted>");
    expect(pending.verification_uri_complete).toBe(
      response.verification_uri_complete,
    );
    expect(pending.agent_action).toMatchObject({
      type: "deliver_and_stop",
      message_format: "markdown",
    });
    expect(pending.agent_action?.message_markdown).toContain(
      pending.verification_uri_complete,
    );
    expect(pending.agent_action?.message_markdown).not.toContain(
      pending.device_code,
    );
  });

  it("accepts a pending response without the optional agent action", async () => {
    const pending = (await fixture("contracts/pairing-pending.json")) as Record<
      string,
      unknown
    >;
    delete pending.agent_action;
    expect(parsePendingPairing(pending).agent_action).toBeUndefined();
  });

  it("rejects an agent action that omits the approval address or leaks the device code", async () => {
    const pending = (await fixture("contracts/pairing-pending.json")) as Record<
      string,
      unknown
    >;
    const action = pending.agent_action as Record<string, unknown>;
    action.message_markdown = "Pairing code: ABCD-EFGH and <redacted>";
    expect(() => parsePendingPairing(pending)).toThrow(/unsafe agent action/u);
  });

  it("rejects a cross-origin approval address", async () => {
    const pending = (await fixture("contracts/pairing-pending.json")) as Record<
      string,
      unknown
    >;
    pending.verification_uri_complete = "https://attacker.example/approve";
    expect(() => parsePendingPairing(pending)).toThrow(/does not match/u);
  });

  it("parses safe identity and server fixtures", async () => {
    expect(
      parseSafeUserResponse(await fixture("contracts/me.json")),
    ).toMatchObject({
      id: "44444444-4444-4444-8444-444444444444",
      email: "user@example.com",
    });
    expect(
      parseServersResponse(await fixture("contracts/servers.json")),
    ).toEqual([
      expect.objectContaining({
        server_id: SERVER_ID,
        workspace_url: "https://workspace.example.com/",
      }),
    ]);
  });

  it("extracts only required pairing credential fields and ignores target extras", () => {
    expect(
      parsePairingCredential({
        status: "paired",
        device_id: DEVICE_ID,
        device_token: "secret-device-token",
        token_type: "Bearer",
        scopes: ["ignored"],
      }),
    ).toEqual({ device_id: DEVICE_ID, device_token: "secret-device-token" });
  });

  it("verifies the returned active device identity", () => {
    expect(
      parseVerifiedDevice(
        {
          paired_device: {
            id: DEVICE_ID,
            status: "active",
            display_name: "Example computer",
          },
        },
        DEVICE_ID,
      ),
    ).toBe("Example computer");
    expect(() =>
      parseVerifiedDevice(
        {
          paired_device: {
            id: SERVER_ID,
            status: "active",
            display_name: "Other",
          },
        },
        DEVICE_ID,
      ),
    ).toThrow(/not verified/u);
  });

  it("accepts only the exact same-origin versioned external-chat handoff", () => {
    expect(
      parseExternalChatHandoff(readyHandoff(), "https://workspace.example.com"),
    ).toMatchObject({ status: "ready", recommended_action: "load_skill" });
    expect(() =>
      parseExternalChatHandoff(
        readyHandoff("https://other.example.com"),
        "https://workspace.example.com",
      ),
    ).toThrow(/unsupported external chat handoff/u);
  });
});
