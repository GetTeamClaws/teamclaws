import { createInterface } from "node:readline/promises";

import { AuthService } from "./auth.js";
import { BrokerClient } from "./broker.js";
import { PACKAGE_VERSION } from "./constants.js";
import { TeamClawsError, safeError } from "./errors.js";
import {
  ExternalChatClient,
  type ChatSendOptions,
  type ChatStartOptions,
  type ChatWatchOptions,
} from "./external-chat.js";
import type { FetchLike } from "./http.js";
import { Output, type Writable } from "./output.js";
import { PairingClient } from "./pairing.js";
import { runShell, shellFetch } from "./shell.js";
import { CredentialStore } from "./storage.js";
import { TargetAuthorization } from "./target-authorization.js";
import type {
  PairingTarget,
  MachineUserRole,
  ServerMetadataUpdate,
  ServerSummary,
} from "./types.js";
import { installRelease, type ReleaseCheck, type Release } from "./update.js";
import { normalizeUuid, parsePairingTarget } from "./validation.js";
import { runUsersAdd, runUsersList } from "./users.js";

export type AppIo = {
  stdout?: Writable;
  stderr?: Writable;
  input?: NodeJS.ReadableStream;
  interactive?: boolean;
};

export type AppDependencies = {
  fetcher?: FetchLike;
  store?: CredentialStore;
  openBrowser?: (url: string) => Promise<boolean>;
  io?: AppIo;
  releaseCheck?: ReleaseCheck;
  installer?: (release: Release, signal?: AbortSignal) => Promise<void>;
};

export async function run(
  arguments_: string[],
  dependencies: AppDependencies = {},
  signal?: AbortSignal,
): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(arguments_);
  } catch (error) {
    const json = arguments_.includes("--json");
    const output = new Output(
      json,
      dependencies.io?.stdout ?? process.stdout,
      dependencies.io?.stderr ?? process.stderr,
    );
    const safe = safeError(error);
    output.error(safe);
    return safe.exitCode;
  }
  const stdout = dependencies.io?.stdout ?? process.stdout;
  const stderr = dependencies.io?.stderr ?? process.stderr;
  const output = new Output(parsed.json, stdout, stderr);
  if (parsed.action === "help") {
    stdout.write(helpText());
    return 0;
  }
  if (parsed.action === "version") {
    stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }
  if (parsed.action === "update") {
    const checked = dependencies.releaseCheck;
    let status: string;
    let message: string;
    let code = 0;
    if (!checked || checked.status === "unavailable") {
      status = "unavailable";
      message =
        "Could not verify an official stable release. No update was installed. Try teamclaws update again later.";
      code = 1;
    } else if (checked.status === "current") {
      status = "current";
      message = "No newer official stable TeamClaws release is available.";
    } else {
      try {
        await (dependencies.installer ?? installRelease)(
          checked.release,
          signal,
        );
        status = "updated";
        message = `Updated TeamClaws to ${checked.release.version}.`;
      } catch {
        status = "failed";
        message =
          "Update failed. Requires the active npm global installation with write permission and npm beside Node. Local, linked, npx, and managed installs must use their original package manager. No privilege elevation was attempted. Check the installed version before retrying.";
        code = 1;
      }
    }
    if (parsed.json)
      stdout.write(
        `${JSON.stringify({ schema_version: 1, event: "update_result", status, message })}\n`,
      );
    else (code ? stderr : stdout).write(`${message}\n`);
    return code;
  }
  const store = dependencies.store ?? new CredentialStore();
  const targetAuthorization = new TargetAuthorization(
    store,
    dependencies.fetcher,
  );
  if (parsed.action === "users_list") {
    try {
      await targetAuthorization.requireGrant();
      output.usersListResult(
        await runUsersList(
          store,
          dependencies.fetcher ?? fetch,
          parsed.target,
          targetAuthorization,
          signal,
        ),
      );
      return 0;
    } catch (error) {
      const safe = safeError(error);
      output.error(safe);
      return safe.exitCode;
    }
  }
  if (parsed.action === "users_add") {
    try {
      await targetAuthorization.requireGrant();
      const result = await runUsersAdd(
        store,
        dependencies.fetcher ?? fetch,
        parsed.target,
        parsed.email,
        parsed.role,
        targetAuthorization,
        signal,
      );
      output.usersAddResult(result);
      return 0;
    } catch (error) {
      const safe = safeError(error);
      output.error(safe);
      return safe.exitCode;
    }
  }
  const auth = new AuthService({
    store,
    output,
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    ...(dependencies.openBrowser
      ? { openBrowser: dependencies.openBrowser }
      : {}),
  });
  const broker = new BrokerClient({
    authorization: targetAuthorization,
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
  });
  const pairing = new PairingClient({
    authorization: targetAuthorization,
    store,
    output,
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    ...(dependencies.openBrowser
      ? { openBrowser: dependencies.openBrowser }
      : {}),
  });
  const externalChat = new ExternalChatClient({
    authorization: targetAuthorization,
    store,
    output,
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
  });
  try {
    switch (parsed.action) {
      case "login":
        await auth.login(parsed.email, signal);
        return 0;
      case "auth_status":
        await auth.status(signal);
        return 0;
      case "logout":
        await auth.logout(signal, parsed.revoke);
        return 0;
    }
    await targetAuthorization.requireGrant();
    switch (parsed.action) {
      case "shell": {
        const result = await runShell(
          store,
          dependencies.fetcher ?? shellFetch,
          parsePairingTarget(parsed.target),
          parsed.command,
          targetAuthorization,
          signal,
        );
        if (parsed.json) stdout.write(`${JSON.stringify(result)}\n`);
        else {
          stdout.write(result.stdout);
          stderr.write(result.stderr);
        }
        return result.exit_code;
      }
      case "servers_list": {
        const inventory = await broker.servers(signal);
        await offerServerMetadata(
          inventory.servers,
          broker,
          parsed.json,
          output,
          dependencies.io,
          signal,
        );
        output.servers(inventory.servers, inventory.workspace_count);
        return 0;
      }
      case "servers_update": {
        const server = await broker.updateServerMetadata(
          parsed.serverId,
          parsed.updates,
          signal,
        );
        output.serverMetadataUpdated(server);
        return 0;
      }
      case "pair": {
        const target = parsed.target
          ? parsePairingTarget(parsed.target)
          : await discoverTarget(
              broker,
              parsed.json,
              output,
              dependencies.io,
              signal,
            );
        const pending = await broker.startPairing(target, signal);
        await pairing.complete(
          pending,
          broker.currentDeviceName(),
          parsed.noOpen,
          signal,
        );
        return 0;
      }
      case "pair_status": {
        const status = await pairing.status(
          parsePairingTarget(parsed.target),
          signal,
        );
        return status === "paired" ? 0 : status === "unreachable" ? 5 : 1;
      }
      case "chat_list":
        return await externalChat.list(
          parsePairingTarget(parsed.target),
          signal,
        );
      case "chat_history":
        return await externalChat.history(
          parsePairingTarget(parsed.target),
          signal,
        );
      case "chat_messages":
        return await externalChat.messages(
          parsePairingTarget(parsed.target),
          parsed.chatId,
          parsed.afterId,
          signal,
        );
      case "chat_capabilities":
        return await externalChat.capabilities(
          parsePairingTarget(parsed.target),
          signal,
        );
      case "chat_start":
        return await externalChat.start(parsed.options, signal);
      case "chat_send":
        return await externalChat.send(parsed.options, signal);
      case "chat_watch":
        return await externalChat.watch(parsed.options, signal);
    }
  } catch (error) {
    const safe = safeError(error);
    output.error(safe);
    return safe.exitCode;
  }
}

type ParsedArguments =
  | { action: "users_list"; json: boolean; target: PairingTarget }
  | {
      action: "users_add";
      json: boolean;
      target: PairingTarget;
      email: string;
      role: MachineUserRole;
    }
  | {
      action: "servers_update";
      json: boolean;
      serverId: string;
      updates: ServerMetadataUpdate;
    }
  | { action: "shell"; json: boolean; target: string; command: string }
  | { action: "help"; json: boolean }
  | { action: "version"; json: boolean }
  | { action: "update"; json: boolean }
  | {
      action: "login";
      json: boolean;
      email?: string;
    }
  | {
      action: "auth_status" | "servers_list";
      json: boolean;
    }
  | { action: "logout"; json: boolean; revoke: boolean }
  | { action: "pair"; json: boolean; target?: string; noOpen: boolean }
  | { action: "pair_status"; json: boolean; target: string }
  | {
      action: "chat_capabilities" | "chat_list" | "chat_history";
      json: boolean;
      target: string;
    }
  | {
      action: "chat_messages";
      json: boolean;
      target: string;
      chatId: string;
      afterId: number;
    }
  | { action: "chat_start"; json: boolean; options: ChatStartOptions }
  | { action: "chat_send"; json: boolean; options: ChatSendOptions }
  | { action: "chat_watch"; json: boolean; options: ChatWatchOptions };

export function parseArguments(arguments_: string[]): ParsedArguments {
  if (arguments_[0] === "servers" && arguments_[1] === "update") {
    const serverId = normalizeUuid(requiredPositional(arguments_, 2));
    const updates: ServerMetadataUpdate = {};
    let json = false;
    for (let index = 3; index < arguments_.length; index += 1) {
      const option = arguments_[index];
      if (option === "--name" && updates.alias === undefined) {
        const value = arguments_[++index];
        if (value === undefined) throw usageError();
        updates.alias = value;
      } else if (
        option === "--description" &&
        updates.description === undefined
      ) {
        const value = arguments_[++index];
        if (value === undefined) throw usageError();
        updates.description = value;
      } else if (option === "--json" && !json) json = true;
      else throw usageError();
    }
    if (Object.keys(updates).length === 0) throw usageError();
    return { action: "servers_update", serverId, updates, json };
  }
  if (arguments_[0] === "shell") {
    const target = requiredPositional(arguments_, 1);
    let command: string | undefined;
    let json = false;
    for (let index = 2; index < arguments_.length; index += 1) {
      const option = arguments_[index];
      if (option === "--command" && command === undefined) {
        command = arguments_[++index];
        if (command === undefined || command.length === 0) throw usageError();
      } else if (option === "--json" && !json) json = true;
      else throw usageError();
    }
    if (command === undefined) throw usageError();
    return { action: "shell", target, command, json };
  }
  const json = arguments_.includes("--json");
  const args = arguments_.filter((argument) => argument !== "--json");
  if (args[0] === "users" && args[1] === "list" && args.length === 3)
    return {
      action: "users_list",
      json,
      target: parsePairingTarget(requiredPositional(args, 2)),
    };
  if (args[0] === "users" && args[1] === "add") {
    const target = parsePairingTarget(requiredPositional(args, 2));
    const email = requiredPositional(args, 3).trim().toLowerCase();
    const options = parseNamedOptions(args.slice(4), {
      values: ["--role"],
      booleans: [],
    });
    const role = options.values["--role"];
    if (
      !email ||
      email.length > 254 ||
      !["user", "staff", "superuser"].includes(role ?? "")
    )
      throw usageError();
    return {
      action: "users_add",
      json,
      target,
      email,
      role: role as MachineUserRole,
    };
  }
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h")
    return { action: "help", json };
  if (args[0] === "--version" || args[0] === "-v")
    return { action: "version", json };
  if (args[0] === "update" && args.length === 1)
    return { action: "update", json };
  if (args[0] === "login") {
    if (args.length === 1) return { action: "login", json };
    if (args.length === 2 && !args[1]!.startsWith("-")) {
      return { action: "login", json, email: args[1]! };
    }
    throw usageError();
  }
  if (
    args[0] === "logout" &&
    (args.length === 1 || (args.length === 2 && args[1] === "--revoke"))
  )
    return { action: "logout", json, revoke: args.length === 2 };
  if (args[0] === "auth" && args[1] === "status" && args.length === 2) {
    return { action: "auth_status", json };
  }
  if (args[0] === "servers" && args[1] === "list" && args.length === 2) {
    return { action: "servers_list", json };
  }
  if (args[0] === "pair") {
    if (args[1] === "status") {
      if (args.length === 3 && !args[2]!.startsWith("-")) {
        return { action: "pair_status", json, target: args[2]! };
      }
      throw usageError();
    }
    const noOpen = args.includes("--no-open");
    const positional = args
      .slice(1)
      .filter((argument) => argument !== "--no-open");
    if (
      positional.length > 1 ||
      positional.some((argument) => argument.startsWith("-"))
    ) {
      throw usageError();
    }
    const target = positional[0];
    return { action: "pair", json, ...(target ? { target } : {}), noOpen };
  }
  if (args[0] === "chat" && args[1] === "list" && args.length === 3) {
    return { action: "chat_list", json, target: requiredPositional(args, 2) };
  }
  if (args[0] === "chat" && args[1] === "history" && args.length === 3) {
    return {
      action: "chat_history",
      json,
      target: requiredPositional(args, 2),
    };
  }
  if (args[0] === "chat" && args[1] === "messages") {
    const target = requiredPositional(args, 2);
    const options = parseNamedOptions(args.slice(3), {
      values: ["--chat-id", "--after-message-id"],
      booleans: [],
    });
    if (!options.values["--chat-id"]) throw usageError();
    return {
      action: "chat_messages",
      json,
      target,
      chatId: normalizeUuid(options.values["--chat-id"]),
      afterId: nonNegativeInteger(options.values["--after-message-id"]),
    };
  }
  if (args[0] === "chat" && args[1] === "capabilities" && args.length === 3) {
    return { action: "chat_capabilities", json, target: args[2]! };
  }
  if (args[0] === "chat" && args[1] === "start") {
    const target = requiredPositional(args, 2);
    const options = parseNamedOptions(args.slice(3), {
      values: [
        "--message",
        "--provider",
        "--model",
        "--reasoning",
        "--client-request-id",
      ],
      booleans: ["--fast", "--no-fast"],
      emptyValues: ["--reasoning"],
    });
    if (
      !options.values["--message"] ||
      (options.flags.has("--fast") && options.flags.has("--no-fast"))
    )
      throw usageError();
    return {
      action: "chat_start",
      json,
      options: {
        target: parsePairingTarget(target),
        message: options.values["--message"],
        ...(options.values["--provider"]
          ? { provider: options.values["--provider"] }
          : {}),
        ...(options.values["--model"]
          ? { model: options.values["--model"] }
          : {}),
        ...(options.values["--reasoning"] !== undefined
          ? { reasoning: options.values["--reasoning"] }
          : {}),
        ...(options.values["--client-request-id"]
          ? { clientRequestId: options.values["--client-request-id"] }
          : {}),
        ...(options.flags.has("--fast") ? { fastMode: true } : {}),
        ...(options.flags.has("--no-fast") ? { fastMode: false } : {}),
      },
    };
  }
  if (args[0] === "chat" && args[1] === "send") {
    const target = requiredPositional(args, 2);
    const options = parseNamedOptions(args.slice(3), {
      values: ["--session-id", "--message", "--client-request-id"],
      booleans: [],
    });
    if (!options.values["--session-id"] || !options.values["--message"])
      throw usageError();
    return {
      action: "chat_send",
      json,
      options: {
        target: parsePairingTarget(target),
        sessionId: options.values["--session-id"],
        message: options.values["--message"],
        ...(options.values["--client-request-id"]
          ? { clientRequestId: options.values["--client-request-id"] }
          : {}),
      },
    };
  }
  if (args[0] === "chat" && args[1] === "watch") {
    const target = requiredPositional(args, 2);
    const options = parseNamedOptions(args.slice(3), {
      values: [
        "--session-id",
        "--request-id",
        "--known-revision",
        "--after-response-message-id",
      ],
      booleans: [],
    });
    if (!options.values["--session-id"] || !options.values["--request-id"])
      throw usageError();
    return {
      action: "chat_watch",
      json,
      options: {
        target: parsePairingTarget(target),
        sessionId: options.values["--session-id"],
        requestId: options.values["--request-id"],
        knownRevision: nonNegativeInteger(options.values["--known-revision"]),
        responseCursor: nonNegativeInteger(
          options.values["--after-response-message-id"],
        ),
      },
    };
  }
  throw usageError();
}

function requiredPositional(args: string[], index: number): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw usageError();
  return value;
}

function parseNamedOptions(
  args: string[],
  allowed: { values: string[]; booleans: string[]; emptyValues?: string[] },
): { values: Record<string, string>; flags: Set<string> } {
  const valueNames = new Set(allowed.values);
  const booleanNames = new Set(allowed.booleans);
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (booleanNames.has(name)) {
      if (flags.has(name)) throw usageError();
      flags.add(name);
      continue;
    }
    if (!valueNames.has(name) || values[name] !== undefined) throw usageError();
    const value = args[index + 1];
    if (
      value === undefined ||
      (value === "" && !allowed.emptyValues?.includes(name)) ||
      value.startsWith("--")
    )
      throw usageError();
    values[name] = value;
    index += 1;
  }
  return { values, flags };
}

function nonNegativeInteger(value?: string): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw usageError();
  return parsed;
}

async function discoverTarget(
  broker: BrokerClient,
  json: boolean,
  output: Output,
  io: AppIo | undefined,
  signal?: AbortSignal,
): Promise<PairingTarget> {
  const inventory = await broker.servers(signal);
  await offerServerMetadata(
    inventory.servers,
    broker,
    json,
    output,
    io,
    signal,
  );
  const servers = inventory.servers.filter((server) => server.pairing_ready);
  if (servers.length === 0) {
    throw new TeamClawsError(
      "no_pairing_ready_workspaces",
      inventory.workspace_count === 0
        ? "No TeamClaws workspaces are available to this account. Purchase a workspace at https://teamclaws.com/app/."
        : "No pairing-ready TeamClaws workspaces are available. Check existing workspaces at https://teamclaws.com/app/; this does not mean you need to purchase another.",
      { exitCode: 4 },
    );
  }
  const interactive =
    io?.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (json || !interactive) {
    throw new TeamClawsError(
      "server_selection_required",
      "Choose a workspace by alias from `teamclaws servers list`, then provide its stable server identifier after the user agrees to pair.",
      { exitCode: 4 },
    );
  }
  output.servers(servers);
  const selected = await promptForServer(
    servers,
    io?.input ?? process.stdin,
    io?.stdout ?? process.stdout,
  );
  return { server_id: selected.server_id };
}

async function offerServerMetadata(
  servers: ServerSummary[],
  broker: BrokerClient,
  json: boolean,
  output: Output,
  io?: AppIo,
  signal?: AbortSignal,
): Promise<void> {
  const interactive =
    io?.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!json && !interactive) return;
  for (const server of servers) {
    if (
      server.can_edit_metadata !== true ||
      server.custom_alias === undefined ||
      server.description === undefined ||
      (server.custom_alias.trim() !== "" && server.description.trim() !== "")
    )
      continue;
    const claimed = await broker.claimMetadataPrompt(server.server_id, signal);
    Object.assign(server, claimed.server);
    if (!claimed.should_prompt) continue;
    output.serverMetadataPrompt(server);
    if (json) continue;
    const terminal = createInterface({
      input: io?.input ?? process.stdin,
      output: (io?.stdout ?? process.stdout) as NodeJS.WritableStream,
    });
    try {
      const answer = await terminal.question(
        "Set the name and description now? [y/N] ",
      );
      if (!/^y(?:es)?$/iu.test(answer.trim())) continue;
      const name = await terminal.question(
        `Name (Enter to keep ${JSON.stringify(server.custom_alias || server.alias)}): `,
      );
      const description = await terminal.question(
        "Description (Enter to keep the current description): ",
      );
      const updates: ServerMetadataUpdate = {};
      if (name.trim()) updates.alias = name;
      if (description.trim()) updates.description = description;
      if (Object.keys(updates).length > 0) {
        const updated = await broker.updateServerMetadata(
          server.server_id,
          updates,
          signal,
        );
        Object.assign(server, updated);
        output.serverMetadataUpdated(updated);
      }
    } finally {
      terminal.close();
    }
  }
}

async function promptForServer(
  servers: ServerSummary[],
  input: NodeJS.ReadableStream,
  output: Writable,
): Promise<ServerSummary> {
  const terminal = createInterface({
    input,
    output: output as NodeJS.WritableStream,
  });
  try {
    const answer = (
      await terminal.question(`Choose a workspace (1-${servers.length}): `)
    ).trim();
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > servers.length) {
      throw new TeamClawsError(
        "invalid_selection",
        "Choose one listed workspace number.",
        {
          exitCode: 4,
        },
      );
    }
    return servers[index - 1]!;
  } finally {
    terminal.close();
  }
}

function usageError(): TeamClawsError {
  return new TeamClawsError(
    "invalid_command",
    "Run `teamclaws --help` for supported commands.",
    {
      exitCode: 2,
    },
  );
}

export function helpText(): string {
  return `TeamClaws ${PACKAGE_VERSION}\n\nUsage:\n  teamclaws update [--json]\n  teamclaws shell <target> --command <text> [--json]\n  teamclaws users add <target> <email> --role <user|staff|superuser> [--json]\n  teamclaws users list <target> [--json]\n  teamclaws login [email] [--json]\n  teamclaws auth status [--json]\n  teamclaws logout [--revoke] [--json]\n  teamclaws servers list [--json]\n  teamclaws servers update <server-id> [--name <text>] [--description <text>] [--json]\n  teamclaws pair status <server-identifier-or-canonical-workspace-address> [--json]\n  teamclaws pair [server-identifier-or-canonical-workspace-address] [--no-open] [--json]\n  teamclaws chat list <target> [--json]\n  teamclaws chat history <target> [--json]\n  teamclaws chat messages <target> --chat-id <uuid> [--after-message-id <n>] [--json]\n  teamclaws chat capabilities <target> [--json]\n  teamclaws chat start <target> --message <text> [selection options] [--json]\n  teamclaws chat send <target> --session-id <uuid> --message <text> [--json]\n  teamclaws chat watch <target> --session-id <uuid> --request-id <uuid> [resume cursors] [--json]\n\nPair status performs one bounded direct verification and stops. Pairing grants the standard host-issued credential. Chat commands use that credential directly against the selected workspace.\n`;
}
