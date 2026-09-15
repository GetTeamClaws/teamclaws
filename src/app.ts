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
import { CredentialStore } from "./storage.js";
import type { PairingTarget, ServerSummary } from "./types.js";
import { parsePairingTarget } from "./validation.js";

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
  const store = dependencies.store ?? new CredentialStore();
  const auth = new AuthService({
    store,
    output,
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    ...(dependencies.openBrowser
      ? { openBrowser: dependencies.openBrowser }
      : {}),
  });
  const broker = new BrokerClient({
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
  });
  const pairing = new PairingClient({
    store,
    output,
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    ...(dependencies.openBrowser
      ? { openBrowser: dependencies.openBrowser }
      : {}),
  });
  const externalChat = new ExternalChatClient({
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
        await auth.logout(signal);
        return 0;
      case "servers_list": {
        const token = await auth.accessToken(signal);
        if (!token) throw loginRequired();
        const servers = await broker.servers(token, signal);
        output.servers(servers);
        return 0;
      }
      case "pair": {
        const token = await auth.accessToken(signal);
        const target = parsed.target
          ? parsePairingTarget(parsed.target)
          : await discoverTarget(
              broker,
              token,
              parsed.json,
              output,
              dependencies.io,
              signal,
            );
        const pending = await broker.startPairing(target, token, signal);
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
  | { action: "help"; json: boolean }
  | { action: "version"; json: boolean }
  | {
      action: "login";
      json: boolean;
      email?: string;
    }
  | {
      action: "auth_status" | "logout" | "servers_list";
      json: boolean;
    }
  | { action: "pair"; json: boolean; target?: string; noOpen: boolean }
  | { action: "pair_status"; json: boolean; target: string }
  | { action: "chat_capabilities"; json: boolean; target: string }
  | { action: "chat_start"; json: boolean; options: ChatStartOptions }
  | { action: "chat_send"; json: boolean; options: ChatSendOptions }
  | { action: "chat_watch"; json: boolean; options: ChatWatchOptions };

export function parseArguments(arguments_: string[]): ParsedArguments {
  const json = arguments_.includes("--json");
  const args = arguments_.filter((argument) => argument !== "--json");
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h")
    return { action: "help", json };
  if (args[0] === "--version" || args[0] === "-v")
    return { action: "version", json };
  if (args[0] === "login") {
    if (args.length === 1) return { action: "login", json };
    if (args.length === 2 && !args[1]!.startsWith("-")) {
      return { action: "login", json, email: args[1]! };
    }
    throw usageError();
  }
  if (args[0] === "logout" && args.length === 1)
    return { action: "logout", json };
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
  token: string | undefined,
  json: boolean,
  output: Output,
  io: AppIo | undefined,
  signal?: AbortSignal,
): Promise<PairingTarget> {
  if (!token) {
    throw new TeamClawsError(
      "login_or_server_required",
      "Sign in or provide a stable server identifier or canonical workspace address.",
      { exitCode: 4 },
    );
  }
  const servers = (await broker.servers(token, signal)).filter(
    (server) => server.pairing_ready,
  );
  if (servers.length === 0) {
    throw new TeamClawsError(
      "no_pairing_ready_workspaces",
      "No pairing-ready TeamClaws workspaces are available.",
      { exitCode: 4 },
    );
  }
  if (servers.length === 1) return { server_id: servers[0]!.server_id };
  const interactive =
    io?.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (json || !interactive) {
    throw new TeamClawsError(
      "server_selection_required",
      "More than one workspace is available. Provide the stable server identifier.",
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

function loginRequired(): TeamClawsError {
  return new TeamClawsError("login_required", "Sign in to TeamClaws first.", {
    exitCode: 3,
  });
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
  return `TeamClaws ${PACKAGE_VERSION}\n\nUsage:\n  teamclaws login [email] [--json]\n  teamclaws auth status [--json]\n  teamclaws logout [--json]\n  teamclaws servers list [--json]\n  teamclaws pair status <server-identifier-or-canonical-workspace-address> [--json]\n  teamclaws pair [server-identifier-or-canonical-workspace-address] [--no-open] [--json]\n  teamclaws chat capabilities <target> [--json]\n  teamclaws chat start <target> --message <text> [selection options] [--json]\n  teamclaws chat send <target> --session-id <uuid> --message <text> [--json]\n  teamclaws chat watch <target> --session-id <uuid> --request-id <uuid> [resume cursors] [--json]\n\nPair status performs one bounded direct verification and stops. Pairing grants the standard host-issued credential. Chat commands use that credential directly against the selected workspace.\n`;
}
