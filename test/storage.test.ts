import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CredentialStore,
  decodeWindowsText,
  isPrivateWindowsAcl,
  parseWindowsAclText,
} from "../src/storage.js";
import type { LoginCredential, WorkspaceCredential } from "../src/types.js";
import { DEVICE_ID, SERVER_ID } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(
        async (root) =>
          await import("node:fs/promises").then(({ rm }) =>
            rm(root, { recursive: true, force: true }),
          ),
      ),
  );
});

describe("credential storage", () => {
  it("atomically stores private login and workspace credentials", async () => {
    const root = await tempRoot();
    const store = new CredentialStore({ root, platform: process.platform });
    const login = loginCredential();
    await store.writeLogin(login);
    expect(await store.readLogin()).toEqual(login);
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(store.loginPath)).mode & 0o777).toBe(0o600);
    }

    const workspace = workspaceCredential();
    const path = await store.writeWorkspace(workspace);
    expect(path).toBe(join(root, "clawgate-devices", `${SERVER_ID}.json`));
    expect(await store.readWorkspace(SERVER_ID)).toEqual(workspace);
    if (process.platform !== "win32") {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(store.workspaceDirectory)).mode & 0o777).toBe(0o700);
    }
    expect(await readFile(path, "utf8")).not.toContain("access-secret");
  });

  it("replaces an existing credential without leaving temporary files", async () => {
    const root = await tempRoot();
    const store = new CredentialStore({ root, platform: process.platform });
    await store.writeLogin(loginCredential());
    const replacement = {
      ...loginCredential(),
      access_token: "replacement-access-token",
    };
    await store.writeLogin(replacement);
    expect(await store.readLogin()).toEqual(replacement);
    const files = await import("node:fs/promises").then(({ readdir }) =>
      readdir(root),
    );
    expect(files).toEqual(["cli-auth.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a credential file readable by other users",
    async () => {
      const root = await tempRoot();
      const store = new CredentialStore({ root, platform: process.platform });
      await store.writeLogin(loginCredential());
      await chmod(store.loginPath, 0o644);
      await expect(store.readLogin()).rejects.toMatchObject({
        code: "credential_storage_failed",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic-link credential file",
    async () => {
      const root = await tempRoot();
      const store = new CredentialStore({ root, platform: process.platform });
      await mkdir(root, { recursive: true });
      const target = join(root, "target.json");
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(target, "{}", { mode: 0o600 }),
      );
      await symlink(target, store.loginPath);
      await expect(store.readLogin()).rejects.toMatchObject({
        code: "credential_storage_failed",
      });
    },
  );

  it("removes local credentials even when already absent", async () => {
    const root = await tempRoot();
    const store = new CredentialStore({ root, platform: process.platform });
    await expect(store.removeLogin()).resolves.toBeUndefined();
    await store.writeWorkspace(workspaceCredential());
    await store.removeWorkspace(SERVER_ID);
    expect(await store.readWorkspace(SERVER_ID)).toBeUndefined();
  });

  it("finds a protected workspace credential by server ID or origin", async () => {
    const root = await tempRoot();
    const store = new CredentialStore({ root, platform: process.platform });
    const workspace = workspaceCredential();
    await store.writeWorkspace(workspace);

    await expect(
      store.findWorkspace({ server_id: SERVER_ID }),
    ).resolves.toMatchObject({
      server_id: workspace.server_id,
      origin: workspace.origin,
      device_id: workspace.device_id,
      device_token: workspace.device_token,
    });
    await expect(
      store.findWorkspace({ workspace_url: "https://workspace.example.com/" }),
    ).resolves.toMatchObject({
      server_id: workspace.server_id,
      origin: workspace.origin,
      device_id: workspace.device_id,
      device_token: workspace.device_token,
    });
    await expect(
      store.findWorkspace({ workspace_url: "https://other.example.com/" }),
    ).resolves.toBeUndefined();
  });

  it("reads an older UUID-named pairing credential for status without rewriting it", async () => {
    const root = await tempRoot();
    const store = new CredentialStore({ root, platform: process.platform });
    await store.writeWorkspace(workspaceCredential());
    const path = store.workspacePath(SERVER_ID);
    const legacy = {
      version: 1,
      server_id: SERVER_ID,
      origin: "https://workspace.example.com",
      machine_url: "https://workspace.example.com",
      device_id: DEVICE_ID,
      device_token: "workspace-secret-value",
      authorization: `Bearer ${DEVICE_ID}:workspace-secret-value`,
      token_type: "Bearer",
      scopes: ["external_chat:capabilities:read"],
      paired_at: "2026-08-27T13:00:00.000Z",
    };
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 }),
    );
    const before = await readFile(path, "utf8");

    await expect(
      store.findWorkspace({ workspace_url: "https://workspace.example.com/" }),
    ).resolves.toEqual({
      version: 1,
      server_id: SERVER_ID,
      origin: "https://workspace.example.com",
      display_name: "Paired device",
      device_id: DEVICE_ID,
      device_token: "workspace-secret-value",
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects malformed local credential JSON", async () => {
    const root = await tempRoot();
    const store = new CredentialStore({ root, platform: process.platform });
    await store.writeLogin(loginCredential());
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(store.loginPath, "not-json", { mode: 0o600 }),
    );
    await expect(store.readLogin()).rejects.toMatchObject({
      code: "invalid_credential_file",
    });
  });
});

describe("Windows credential ACL verification", () => {
  const userSid = "S-1-5-21-111-222-333-1001";

  it.each([
    [
      "directory",
      `teamclaws-acl-probe\\private\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${userSid})\r\n`,
    ],
    ["file", `empty.bin\r\nD:PAI(A;;FA;;;SY)(A;;FA;;;${userSid})\r\n`],
  ])("decodes a BOM-less UTF-16LE %s ACL record", (_kind, record) => {
    const text = decodeWindowsText(Buffer.from(record, "utf16le"));
    expect(text).toBe(record);
    expect(isPrivateWindowsAcl(parseWindowsAclText(text), userSid)).toBe(true);
  });

  it("decodes a UTF-16LE ACL record with a byte-order mark", () => {
    const record = `empty.bin\r\nD:P(A;;FA;;;SY)(A;;FA;;;${userSid})\r\n`;
    const buffer = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(record, "utf16le"),
    ]);

    expect(decodeWindowsText(buffer)).toBe(record);
  });

  it("reads the security descriptor after a path on drive D", () => {
    const record = `D:\\a\\_temp\\private\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${userSid})\r\n`;
    expect(isPrivateWindowsAcl(parseWindowsAclText(record), userSid)).toBe(
      true,
    );
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["BOM-only", Buffer.from([0xff, 0xfe])],
    ["UTF-8", Buffer.from(`D:P(A;;FA;;;SY)(A;;FA;;;${userSid})`, "utf8")],
    ["odd-length UTF-16LE", Buffer.from([0x44, 0x00, 0x3a])],
    ["UTF-16BE", Buffer.from([0xfe, 0xff, 0x00, 0x44, 0x00, 0x3a])],
  ])("rejects an unsupported %s ACL byte shape", (_kind, buffer) => {
    expect(() => decodeWindowsText(buffer)).toThrowError(
      expect.objectContaining({ code: "credential_storage_failed" }),
    );
  });

  it("accepts a protected current-user and Local System SDDL ACL", () => {
    const acl = parseWindowsAclText(
      `private D:P(A;OICI;FA;;;${userSid})(A;OICI;FA;;;SY)\r\n`,
    );

    expect(acl).toEqual({
      protected: true,
      trustees: [userSid, "S-1-5-18"],
    });
    expect(isPrivateWindowsAcl(acl, userSid)).toBe(true);
  });

  it("resolves the Administrators group to its numeric SID for removal", () => {
    const acl = parseWindowsAclText(`D:P(A;;FA;;;SY)(A;;FA;;;BA)`);
    expect(acl.trustees).toEqual(["S-1-5-18", "S-1-5-32-544"]);
    expect(isPrivateWindowsAcl(acl, userSid)).toBe(false);
  });

  it("does not treat an unresolved local administrator alias as the current user", () => {
    const acl = parseWindowsAclText(`D:P(A;;FA;;;SY)(A;;FA;;;LA)`);
    expect(isPrivateWindowsAcl(acl, userSid)).toBe(false);
  });

  it.each([
    [
      "an unprotected DACL even when an ACE right contains P",
      `D:(A;;RP;;;${userSid})(A;;FA;;;SY)`,
    ],
    ["a missing Local System trustee", `D:P(A;;FA;;;${userSid})`],
    [
      "an additional broad trustee",
      `D:P(A;;FA;;;${userSid})(A;;FA;;;SY)(A;;FR;;;BA)`,
    ],
  ])("rejects %s", (_label, descriptor) => {
    expect(isPrivateWindowsAcl(parseWindowsAclText(descriptor), userSid)).toBe(
      false,
    );
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "teamclaws-storage-test-"));
  roots.push(root);
  return join(root, "private");
}

function loginCredential(): LoginCredential {
  return {
    version: 1,
    token_type: "Bearer",
    access_token: "access-secret-value",
    refresh_token: "refresh-secret-value",
    expires_at: "2026-08-27T14:00:00.000Z",
  };
}

function workspaceCredential(): WorkspaceCredential {
  return {
    version: 1,
    server_id: SERVER_ID,
    origin: "https://workspace.example.com",
    display_name: "Example computer",
    device_id: DEVICE_ID,
    device_token: "workspace-secret-value",
    created_at: "2026-08-27T13:00:00.000Z",
  };
}
