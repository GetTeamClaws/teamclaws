import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { TeamClawsError } from "./errors.js";
import {
  parseDurableAuthorization,
  type DurableAuthorization,
} from "./target-authorization.js";
import type {
  LoginCredential,
  PairingTarget,
  StatusWorkspaceCredential,
  WorkspaceCredential,
} from "./types.js";
import {
  isObject,
  requireHttpsUrl,
  requireInteger,
  normalizeUuid,
  parseLoginCredential,
  parseStatusWorkspaceCredential,
  parseWorkspaceCredential,
} from "./validation.js";

const execFile = promisify(execFileCallback);
const SYSTEM_SID = "S-1-5-18";
const MAX_WORKSPACE_CREDENTIAL_FILES = 256;
const UUID_CREDENTIAL_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu;

export type ConversationReference = {
  server_id: string;
  origin: string;
  device_id: string;
  session_id: string;
  request_id: string;
  owner_conversation_url: string;
  revision: number;
  response_cursor: number;
  updated_at: string;
};

export type FileStoreOptions = {
  root?: string;
  platform?: NodeJS.Platform;
};

export class CredentialStore {
  readonly root: string;
  readonly loginPath: string;
  readonly authorizationPath: string;
  readonly workspaceDirectory: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: FileStoreOptions = {}) {
    this.root = options.root ?? defaultRoot();
    this.loginPath = join(this.root, "cli-auth.json");
    this.authorizationPath = join(this.root, "cli-authorization.json");
    this.workspaceDirectory = join(this.root, "clawgate-devices");
    this.platform = options.platform ?? process.platform;
  }

  async readLogin(): Promise<LoginCredential | undefined> {
    const value = await this.readJsonIfPresent(this.loginPath);
    return value === undefined ? undefined : parseLoginCredential(value);
  }

  async writeLogin(credential: LoginCredential): Promise<void> {
    await this.writePrivateJson(this.loginPath, credential);
  }

  async removeLogin(): Promise<void> {
    await unlink(this.loginPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw storageError();
    });
  }

  async readAuthorization(): Promise<DurableAuthorization | undefined> {
    const value = await this.readJsonIfPresent(this.authorizationPath);
    return value === undefined ? undefined : parseDurableAuthorization(value);
  }

  async writeAuthorization(grant: DurableAuthorization): Promise<void> {
    await this.writePrivateJson(
      this.authorizationPath,
      parseDurableAuthorization(grant),
    );
  }

  async removeAuthorization(): Promise<void> {
    await unlink(this.authorizationPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw storageError();
      },
    );
  }

  workspacePath(serverId: string): string {
    return join(this.workspaceDirectory, `${normalizeUuid(serverId)}.json`);
  }

  async readWorkspace(
    serverId: string,
  ): Promise<WorkspaceCredential | undefined> {
    const value = await this.readJsonIfPresent(this.workspacePath(serverId));
    return value === undefined ? undefined : parseWorkspaceCredential(value);
  }

  async readWorkspaceForStatus(
    serverId: string,
  ): Promise<StatusWorkspaceCredential | undefined> {
    const normalized = normalizeUuid(serverId);
    const value = await this.readJsonIfPresent(this.workspacePath(normalized));
    return value === undefined
      ? undefined
      : parseStatusWorkspaceCredential(value, normalized);
  }

  async findWorkspace(
    target: PairingTarget,
  ): Promise<StatusWorkspaceCredential | undefined> {
    if ("server_id" in target)
      return this.readWorkspaceForStatus(target.server_id);

    const origin = new URL(target.workspace_url).origin;
    let names: string[];
    try {
      await this.assertPrivateDirectory(this.workspaceDirectory);
      names = await readdir(this.workspaceDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof TeamClawsError) throw error;
      throw storageError();
    }
    if (names.length > MAX_WORKSPACE_CREDENTIAL_FILES) throw storageError();

    const matches: StatusWorkspaceCredential[] = [];
    for (const name of names.sort()) {
      if (!UUID_CREDENTIAL_NAME.test(name)) continue;
      const credential = await this.readWorkspaceForStatus(name.slice(0, -5));
      if (credential?.origin === origin) matches.push(credential);
    }
    if (matches.length > 1) {
      throw new TeamClawsError(
        "ambiguous_workspace_credential",
        "More than one saved credential matches this workspace.",
        { exitCode: 9 },
      );
    }
    return matches[0];
  }

  async writeWorkspace(credential: WorkspaceCredential): Promise<string> {
    await this.ensurePrivateDirectory(this.workspaceDirectory);
    const path = this.workspacePath(credential.server_id);
    await this.writePrivateJson(path, credential);
    return path;
  }

  async removeWorkspace(serverId: string): Promise<void> {
    await unlink(this.workspacePath(serverId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw storageError();
      },
    );
  }

  private conversationDirectory(credential: StatusWorkspaceCredential): string {
    return join(
      this.root,
      "chat-references",
      normalizeUuid(credential.server_id),
      normalizeUuid(credential.device_id),
    );
  }

  private async checkConversationDirectory(
    credential: StatusWorkspaceCredential,
  ): Promise<void> {
    const directory = this.conversationDirectory(credential);
    for (const path of [
      this.root,
      join(this.root, "chat-references"),
      dirname(directory),
      directory,
    ]) {
      const info = await lstat(path);
      if (
        this.platform !== "win32" &&
        info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === process.getuid?.() &&
        (info.mode & 0o077) !== 0
      )
        throw conversationStorageError(
          `Directory ${JSON.stringify(path)} has mode ${(info.mode & 0o777).toString(8).padStart(4, "0")}; mode 0700 is required. Run chmod 700 '${path.replaceAll("'", "'\\''")}' and retry. `,
        );
      await this.assertPrivateDirectory(path);
    }
  }

  async listConversations(
    credential: StatusWorkspaceCredential,
  ): Promise<ConversationReference[]> {
    try {
      const directory = this.conversationDirectory(credential);
      try {
        await this.checkConversationDirectory(credential);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const records: ConversationReference[] = [];
      for (const name of (await readdir(directory)).sort()) {
        if (!UUID_CREDENTIAL_NAME.test(name)) continue;
        const path = join(directory, name);
        // A single reference is small; reject unexpectedly large local files.
        if ((await lstat(path)).size > 16_384) throw conversationStorageError();
        const value = await this.readJsonIfPresent(path);
        if (value === undefined) continue;
        const record = parseConversationReference(value, credential);
        if (name !== `${record.session_id}.json`)
          throw conversationStorageError();
        records.push(record);
      }
      return records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    } catch (error) {
      if (
        error instanceof TeamClawsError &&
        error.code === "chat_reference_storage_failed"
      )
        throw error;
      throw conversationStorageError();
    }
  }

  async upsertConversation(
    credential: StatusWorkspaceCredential,
    reference: ConversationReference,
  ): Promise<void> {
    try {
      const record = parseConversationReference(reference, credential);
      const directory = this.conversationDirectory(credential);
      await this.ensurePrivateDirectory(directory);
      const path = join(directory, `${record.session_id}.json`);
      const existing = await this.readJsonIfPresent(path);
      if (existing !== undefined) {
        const prior = parseConversationReference(existing, credential);
        if (prior.session_id !== record.session_id)
          throw conversationStorageError();
        // Resuming an earlier cursor must not regress this request's saved progress.
        if (prior.request_id === record.request_id) {
          record.revision = Math.max(prior.revision, record.revision);
          record.response_cursor = Math.max(
            prior.response_cursor,
            record.response_cursor,
          );
        }
      }
      await this.writePrivateJson(path, record);
    } catch {
      throw conversationStorageError();
    }
  }

  private async readJsonIfPresent(path: string): Promise<unknown | undefined> {
    try {
      await this.assertRegularPrivateFile(path);
      const text = await readFile(path, "utf8");
      return JSON.parse(text) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof TeamClawsError) throw error;
      throw new TeamClawsError(
        "invalid_credential_file",
        "The local TeamClaws credential file could not be read safely.",
        { exitCode: 9 },
      );
    }
  }

  private async writePrivateJson(path: string, value: unknown): Promise<void> {
    await this.ensurePrivateDirectory(dirname(path));
    const temporaryPath = join(
      dirname(path),
      `.${basename(path)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, {
        encoding: "utf8",
      });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.protectFile(temporaryPath);
      await rename(temporaryPath, path);
      await this.protectFile(path);
      await this.flushDirectory(dirname(path));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof TeamClawsError) throw error;
      throw storageError();
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    const parent = dirname(path);
    if (path !== this.root && parent !== path && parent.startsWith(this.root)) {
      await this.ensurePrivateDirectory(parent);
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
    if (this.platform === "win32") await protectWindowsPath(path, true);
    else {
      await chmod(path, 0o700);
      const checked = await stat(path);
      if ((checked.mode & 0o777) !== 0o700) throw storageError();
      if (
        typeof process.getuid === "function" &&
        checked.uid !== process.getuid()
      )
        throw storageError();
    }
  }

  private async protectFile(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw storageError();
    if (this.platform === "win32") await protectWindowsPath(path, false);
    else {
      await chmod(path, 0o600);
      const checked = await stat(path);
      if ((checked.mode & 0o777) !== 0o600) throw storageError();
      if (
        typeof process.getuid === "function" &&
        checked.uid !== process.getuid()
      )
        throw storageError();
    }
  }

  private async assertRegularPrivateFile(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw storageError();
    if (this.platform === "win32") await verifyWindowsPath(path);
    else {
      if ((info.mode & 0o077) !== 0) throw storageError();
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw storageError();
    }
  }

  private async assertPrivateDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
    if (this.platform === "win32") await verifyWindowsPath(path);
    else {
      if ((info.mode & 0o077) !== 0) throw storageError();
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw storageError();
    }
  }

  private async flushDirectory(path: string): Promise<void> {
    if (this.platform === "win32") return;
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function defaultRoot(): string {
  if (process.platform === "win32") {
    const profile = process.env.USERPROFILE;
    if (!profile) throw storageError();
    return join(profile, ".teamclaws");
  }
  return join(homedir(), ".teamclaws");
}

async function protectWindowsPath(
  path: string,
  directory: boolean,
): Promise<void> {
  const userSid = await currentWindowsSid();
  const inheritance = directory ? "(OI)(CI)F" : "F";
  try {
    await execFile("icacls.exe", [path, "/inheritance:r", "/q"]);
    await execFile("icacls.exe", [
      path,
      "/grant:r",
      `*${userSid}:${inheritance}`,
      `*${SYSTEM_SID}:${inheritance}`,
      "/q",
    ]);
    const current = await readWindowsAcl(path);
    for (const trustee of current.trustees) {
      if (trustee !== userSid && trustee !== SYSTEM_SID) {
        await execFile("icacls.exe", [
          path,
          "/remove:g",
          `*${trustee}`,
          "/remove:d",
          `*${trustee}`,
          "/q",
        ]);
      }
    }
    await verifyWindowsPath(path, userSid);
  } catch (error) {
    if (error instanceof TeamClawsError) throw error;
    throw storageError();
  }
}

async function verifyWindowsPath(
  path: string,
  knownUserSid?: string,
): Promise<void> {
  const userSid = knownUserSid ?? (await currentWindowsSid());
  const acl = await readWindowsAcl(path);
  if (!isPrivateWindowsAcl(acl, userSid)) {
    throw storageError();
  }
}

type WindowsAcl = { protected: boolean; trustees: string[] };

let localAdministratorSid: Promise<string> | undefined;

function resolveLocalAdministratorSid(): Promise<string> {
  return (localAdministratorSid ??= execFile(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Security.AccessControl.RawSecurityDescriptor]::new('D:(A;;FA;;;LA)').DiscretionaryAcl[0].SecurityIdentifier.Value",
    ],
    { encoding: "utf8" },
  ).then(({ stdout }) => {
    const sid = stdout.trim();
    if (!/^S-1-5-21-\d+-\d+-\d+-500$/u.test(sid)) throw storageError();
    return sid;
  }));
}

export function isPrivateWindowsAcl(acl: WindowsAcl, userSid: string): boolean {
  const allowed = new Set([userSid, SYSTEM_SID]);
  return (
    acl.protected &&
    acl.trustees.length === 2 &&
    acl.trustees.every((trustee) => allowed.has(trustee))
  );
}

async function readWindowsAcl(path: string): Promise<WindowsAcl> {
  const aclPath = join(tmpdir(), `teamclaws-acl-${randomUUID()}.txt`);
  try {
    await execFile("icacls.exe", [path, "/save", aclPath, "/c", "/q"]);
    const buffer = await readFile(aclPath);
    const text = decodeWindowsText(buffer);
    const acl = parseWindowsAclText(text);
    if (acl.trustees.includes("LA")) {
      const administratorSid = await resolveLocalAdministratorSid();
      acl.trustees = acl.trustees.map((sid) =>
        sid === "LA" ? administratorSid : sid,
      );
    }
    return acl;
  } finally {
    await rm(aclPath, { force: true }).catch(() => undefined);
  }
}

export function parseWindowsAclText(text: string): WindowsAcl {
  const descriptor =
    text.split(/\r?\n/u).find((line) => /D:(?:P|AI|AR)*(?:\(|$)/u.test(line)) ??
    "";
  const daclStart = descriptor.indexOf("D:");
  if (daclStart < 0) return { protected: false, trustees: [] };
  const daclBodyStart = daclStart + 2;
  const saclStart = descriptor.indexOf("S:", daclBodyStart);
  const dacl = descriptor.slice(
    daclBodyStart,
    saclStart < 0 ? undefined : saclStart,
  );
  const firstAce = dacl.indexOf("(");
  const controlFlags = dacl.slice(0, firstAce < 0 ? undefined : firstAce);
  const trustees = [...dacl.matchAll(/;;;([^;)]+)\)/gu)].map((match) =>
    match[1] === "SY"
      ? SYSTEM_SID
      : match[1] === "BA"
        ? "S-1-5-32-544"
        : (match[1] ?? ""),
  );
  return {
    protected: controlFlags.includes("P"),
    trustees: [...new Set(trustees)],
  };
}

async function currentWindowsSid(): Promise<string> {
  try {
    const { stdout } = await execFile(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
      ["/user", "/fo", "csv", "/nh"],
      {
        encoding: "utf8",
      },
    );
    const match = stdout.match(/"(S-\d(?:-\d+)+)"/u);
    if (!match?.[1]) throw storageError();
    return match[1];
  } catch (error) {
    if (error instanceof TeamClawsError) throw error;
    throw storageError();
  }
}

export function decodeWindowsText(buffer: Buffer): string {
  const hasLittleEndianBom = buffer[0] === 0xff && buffer[1] === 0xfe;
  if (buffer[0] === 0xfe && buffer[1] === 0xff) throw storageError();

  const contents = hasLittleEndianBom ? buffer.subarray(2) : buffer;
  if (contents.length === 0 || contents.length % 2 !== 0) throw storageError();

  const text = contents.toString("utf16le");
  if (
    text.includes("\u0000") ||
    text.includes("\ufffd") ||
    !text.split(/\r?\n/u).some((line) => line.includes("D:"))
  )
    throw storageError();
  return text;
}

function storageError(): TeamClawsError {
  return new TeamClawsError(
    "credential_storage_failed",
    "TeamClaws could not protect the local credential file.",
    { exitCode: 9 },
  );
}

function parseConversationReference(
  value: unknown,
  credential: StatusWorkspaceCredential,
): ConversationReference {
  if (!isObject(value)) throw conversationStorageError();
  const server = normalizeUuid(value.server_id);
  const device = normalizeUuid(value.device_id);
  const origin = requireHttpsUrl(value.origin, "workspace origin").origin;
  const owner = requireHttpsUrl(
    value.owner_conversation_url,
    "conversation URL",
  );
  if (
    server !== normalizeUuid(credential.server_id) ||
    device !== normalizeUuid(credential.device_id) ||
    origin !== credential.origin ||
    value.origin !== origin ||
    owner.origin !== origin ||
    !owner.pathname.startsWith("/teamclaws-admin/") ||
    typeof value.updated_at !== "string" ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    new Date(value.updated_at).toISOString() !== value.updated_at
  )
    throw conversationStorageError();
  return {
    server_id: server,
    origin,
    device_id: device,
    session_id: normalizeUuid(value.session_id),
    request_id: normalizeUuid(value.request_id),
    owner_conversation_url: owner.toString(),
    revision: requireInteger(value.revision, "revision", 1, 2 ** 31 - 1),
    response_cursor: requireInteger(
      value.response_cursor,
      "response cursor",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    updated_at: value.updated_at,
  };
}

function conversationStorageError(detail = ""): TeamClawsError {
  return new TeamClawsError(
    "chat_reference_storage_failed",
    `${detail}The local conversation references could not be read or saved safely. Retain any returned session/request identifiers; do not resend the message automatically.`,
    { exitCode: 9 },
  );
}
