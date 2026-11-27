import { createInterface } from "node:readline/promises";

import { AuthService } from "./auth.js";
import { BrokerClient } from "./broker.js";
import {
  isUpgradeRunId,
  runClawgateUpgrade,
  type UpgradeOperation,
} from "./clawgate-upgrade.js";
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
import { runProjects, type ProjectRequest } from "./projects.js";
import { runShell, shellFetch } from "./shell.js";
import { fileLink } from "./file-link.js";
import { CredentialStore } from "./storage.js";
import { TargetAuthorization } from "./target-authorization.js";
import type {
  EmailProvider,
  EmailAssignmentPolicy,
  FeedbackLabel,
  GitAccessLevel,
  GitPermissionMap,
  PairingTarget,
  MachineUserRole,
  ServerMetadataUpdate,
  ServerSummary,
} from "./types.js";
import { installRelease, type ReleaseCheck, type Release } from "./update.js";
import { normalizeUuid, parsePairingTarget } from "./validation.js";
import { runUsersAdd, runUsersList, runUsersRemove } from "./users.js";

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
  if (
    arguments_[0] === "servers" &&
    !parsed.json &&
    (dependencies.io?.interactive ??
      (process.stdin.isTTY && process.stdout.isTTY))
  ) {
    stderr.write(
      "The servers command is deprecated. Use teamclaws workspaces instead.\n",
    );
  }
  if (parsed.action === "help") {
    stdout.write(parsed.text ?? helpText());
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
        parsed.sudoEnabled,
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
  if (parsed.action === "users_remove") {
    try {
      await targetAuthorization.requireGrant();
      output.usersRemoveResult(
        await runUsersRemove(
          store,
          dependencies.fetcher ?? fetch,
          parsed.target,
          parsed.email,
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
      case "signup":
        await auth.signup(parsed.email, signal);
        return 0;
      case "signup_verify":
        await auth.verifySignup(
          await readSignupCode(dependencies.io?.input ?? process.stdin, signal),
          signal,
        );
        return 0;
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
      case "file_link": {
        const result = await fileLink(
          store,
          dependencies.fetcher ?? shellFetch,
          parsePairingTarget(parsed.target),
          parsed.path,
          targetAuthorization,
          broker,
          signal,
        );
        stdout.write(
          parsed.json ? `${JSON.stringify(result)}\n` : `${result.url}\n`,
        );
        return 0;
      }
      case "projects": {
        const result = await runProjects(
          store,
          dependencies.fetcher ?? fetch,
          parsePairingTarget(parsed.target),
          parsed.projectRequest,
          targetAuthorization,
          broker,
          signal,
        );
        stdout.write(
          `${JSON.stringify(result, null, parsed.json ? undefined : 2)}\n`,
        );
        return result.ok === true ? 0 : 1;
      }
      case "shell": {
        const result = await runShell(
          store,
          dependencies.fetcher ?? shellFetch,
          parsePairingTarget(parsed.target),
          parsed.command,
          targetAuthorization,
          broker,
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
        output.servers(inventory.servers, inventory.workspace_count, true);
        return 0;
      }
      case "workspace_claim": {
        const claim = await broker.claimLiteTrial(signal);
        if (parsed.json) stdout.write(`${JSON.stringify(claim)}\n`);
        else {
          stdout.write(`Lite workspace: ${claim.workspace_id}\n`);
          if (claim.expires_at)
            stdout.write(`Trial access until: ${claim.expires_at}\n`);
        }
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
      case "servers_upgrade": {
        const result = await runClawgateUpgrade(
          store,
          dependencies.fetcher ?? fetch,
          targetAuthorization,
          parsed.target,
          parsed.operation,
          (message) => stderr.write(`${message}\n`),
          signal,
        );
        output.clawgateUpgrade(result);
        return ["accepted", "running", "ready"].includes(result.outcome)
          ? 0
          : 1;
      }
      case "git_repos":
        output.gitRepositories(await broker.gitRepositories(signal));
        return 0;
      case "email_accounts":
        output.emailAccounts(await broker.emailAccounts(signal));
        return 0;
      case "email_list":
        output.emailAssignments(
          await broker.emailAssignments(parsed.serverId, signal),
        );
        return 0;
      case "email_set":
      case "email_remove":
        output.emailAssignmentResult(
          await broker.changeEmailAssignment(
            parsed.serverId,
            parsed.provider,
            parsed.accountId,
            parsed.action === "email_set" ? parsed.policy : undefined,
            signal,
          ),
        );
        return 0;
      case "feedback":
        output.feedbackResult(
          await broker.submitFeedback(
            parsed.label,
            parsed.title,
            parsed.body,
            signal,
          ),
        );
        return 0;
      case "git_list":
        output.gitAssignments(
          await broker.gitAssignments(parsed.serverId, signal),
        );
        return 0;
      case "git_set":
        output.gitAssignmentResult(
          await broker.setGitAssignment(
            parsed.serverId,
            parsed.repositoryId,
            parsed.permissions,
            signal,
          ),
        );
        return 0;
      case "git_remove":
        output.gitAssignmentResult(
          await broker.removeGitAssignment(
            parsed.serverId,
            parsed.repositoryId,
            signal,
          ),
        );
        return 0;
      case "pair": {
        const selected = parsed.target
          ? undefined
          : await discoverTarget(
              broker,
              parsed.json,
              output,
              dependencies.io,
              signal,
            );
        const target = selected
          ? { server_id: selected.server_id }
          : parsePairingTarget(parsed.target!);
        const pending = await broker.startPairing(target, signal);
        let workspaceName = selected?.alias;
        if (!workspaceName) {
          try {
            const inventory = await broker.servers(signal);
            workspaceName = inventory.servers.find(
              (workspace) =>
                workspace.server_id === pending.server_id &&
                new URL(workspace.workspace_url).origin ===
                  pending.target.origin,
            )?.alias;
          } catch (error) {
            if (signal?.aborted) throw error;
            // The workspace URL is sufficient if the optional label is unavailable.
          }
        }
        await pairing.complete(
          pending,
          broker.currentDeviceName(),
          parsed.noOpen,
          signal,
          workspaceName,
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
  | {
      action: "projects";
      json: boolean;
      target: string;
      projectRequest: ProjectRequest;
    }
  | { action: "email_accounts"; json: boolean }
  | { action: "email_list"; json: boolean; serverId: string }
  | {
      action: "email_set";
      json: boolean;
      serverId: string;
      provider: EmailProvider;
      accountId: number;
      policy: EmailAssignmentPolicy;
    }
  | {
      action: "email_remove";
      json: boolean;
      serverId: string;
      provider: EmailProvider;
      accountId: number;
    }
  | {
      action: "feedback";
      json: boolean;
      label: FeedbackLabel;
      title: string;
      body: string;
    }
  | { action: "git_repos"; json: boolean }
  | { action: "git_list"; json: boolean; serverId: string }
  | {
      action: "git_remove";
      json: boolean;
      serverId: string;
      repositoryId: number;
    }
  | {
      action: "git_set";
      json: boolean;
      serverId: string;
      repositoryId: number;
      permissions: GitPermissionMap;
    }
  | { action: "users_list"; json: boolean; target: PairingTarget }
  | {
      action: "users_remove";
      json: boolean;
      target: PairingTarget;
      email: string;
    }
  | {
      action: "users_add";
      json: boolean;
      target: PairingTarget;
      email: string;
      role: MachineUserRole;
      sudoEnabled: boolean;
    }
  | {
      action: "servers_update";
      json: boolean;
      serverId: string;
      updates: ServerMetadataUpdate;
    }
  | {
      action: "servers_upgrade";
      json: boolean;
      target: PairingTarget;
      operation: UpgradeOperation;
    }
  | { action: "file_link"; json: boolean; target: string; path: string }
  | { action: "shell"; json: boolean; target: string; command: string }
  | { action: "help"; json: boolean; text?: string }
  | { action: "version"; json: boolean }
  | { action: "update"; json: boolean }
  | {
      action: "login" | "signup";
      json: boolean;
      email: string;
    }
  | { action: "signup_verify"; json: boolean }
  | {
      action: "auth_status" | "servers_list" | "workspace_claim";
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
  if (arguments_[0] === "files" && arguments_[1] === "link") {
    const target = requiredPositional(arguments_, 2);
    const { values, flags } = parseNamedOptions(arguments_.slice(3), {
      values: ["--path"],
      booleans: ["--json"],
    });
    const path = values["--path"];
    if (!path) throw usageError();
    return { action: "file_link", target, path, json: flags.has("--json") };
  }
  if (arguments_[0] === "projects") {
    const operation = arguments_[1];
    if (
      !["list", "create", "rename", "delete", "hide", "show"].includes(
        operation ?? "",
      )
    )
      throw usageError();
    const target = requiredPositional(arguments_, 2);
    const { values, flags } = parseNamedOptions(arguments_.slice(3), {
      values: ["--project-id", "--path", "--name", "--request-id"],
      booleans: ["--create-directory", "--delete-directory", "--json"],
    });
    const projectRequest: ProjectRequest = {
      action: operation as ProjectRequest["action"],
    };
    if (operation !== "list")
      projectRequest.request_id = normalizeUuid(values["--request-id"] ?? "");
    if (values["--project-id"] !== undefined) {
      const id = Number(values["--project-id"]);
      if (!Number.isSafeInteger(id) || id <= 0) throw usageError();
      projectRequest.project_id = id;
    }
    if (values["--path"] !== undefined) projectRequest.path = values["--path"];
    if (values["--name"] !== undefined) projectRequest.name = values["--name"];
    if (flags.has("--create-directory")) projectRequest.create_directory = true;
    if (flags.has("--delete-directory")) projectRequest.delete_directory = true;
    if (
      operation === "create" &&
      (!projectRequest.path ||
        projectRequest.project_id !== undefined ||
        projectRequest.name !== undefined ||
        projectRequest.delete_directory)
    )
      throw usageError();
    if (
      ["rename", "delete", "hide", "show"].includes(operation!) &&
      !projectRequest.project_id
    )
      throw usageError();
    if (operation === "rename" && !projectRequest.name && !projectRequest.path)
      throw usageError();
    if (operation !== "create" && projectRequest.create_directory)
      throw usageError();
    if (operation !== "delete" && projectRequest.delete_directory)
      throw usageError();
    if (
      ["list", "hide", "show", "delete"].includes(operation!) &&
      (projectRequest.path || projectRequest.name)
    )
      throw usageError();
    if (
      operation === "list" &&
      (projectRequest.project_id || values["--request-id"])
    )
      throw usageError();
    return {
      action: "projects",
      target,
      projectRequest,
      json: flags.has("--json"),
    };
  }

  if (arguments_[0] === "signup") {
    const verify = arguments_[1] === "verify";
    const options = arguments_.slice(verify ? 2 : 1);
    const helpOptions = options.filter((arg) => arg !== "--json");
    if (
      helpOptions.length === 1 &&
      (helpOptions[0] === "--help" || helpOptions[0] === "-h")
    ) {
      return {
        action: "help",
        json: options.includes("--json"),
        text: verify
          ? `Usage: ${SIGNUP_VERIFY_USAGE}\n\n${SIGNUP_CODE_INPUT}\n`
          : `Usage: teamclaws signup <email> [--json]\n\nSends a signup code to your email. Then run ${SIGNUP_VERIFY_USAGE}.\n${SIGNUP_CODE_INPUT}\n`,
      };
    }
    if (verify) {
      if (!options.includes("--code-stdin"))
        throw usageError(`Run ${SIGNUP_VERIFY_USAGE}. ${SIGNUP_CODE_INPUT}`);
      const { flags } = parseNamedOptions(options, {
        values: [],
        booleans: ["--code-stdin", "--json"],
      });
      return { action: "signup_verify", json: flags.has("--json") };
    }
    const email = requiredPositional(arguments_, 1);
    const { flags } = parseNamedOptions(options.slice(1), {
      values: [],
      booleans: ["--json"],
    });
    return { action: "signup", email, json: flags.has("--json") };
  }
  if (arguments_[0] === "email") {
    const operation = arguments_[1];
    if (operation === "accounts") {
      const { flags } = parseNamedOptions(arguments_.slice(2), {
        values: [],
        booleans: ["--json"],
      });
      return { action: "email_accounts", json: flags.has("--json") };
    }
    const serverId = normalizeUuid(requiredPositional(arguments_, 2));
    if (operation === "list") {
      const { flags } = parseNamedOptions(arguments_.slice(3), {
        values: [],
        booleans: ["--json"],
      });
      return { action: "email_list", serverId, json: flags.has("--json") };
    }
    if (operation !== "set" && operation !== "remove") throw usageError();
    const provider = requiredPositional(arguments_, 3);
    if (provider !== "google" && provider !== "microsoft") throw usageError();
    const rawId = requiredPositional(arguments_, 4);
    const accountId = Number(rawId);
    if (!/^[1-9][0-9]*$/.test(rawId) || !Number.isSafeInteger(accountId))
      throw usageError();
    const { values, flags } = parseNamedOptions(arguments_.slice(5), {
      values: operation === "set" ? ["--policy"] : [],
      booleans: ["--json"],
    });
    const json = flags.has("--json");
    if (operation === "remove")
      return { action: "email_remove", serverId, provider, accountId, json };
    const policy = values["--policy"];
    if (
      policy !== "read_only" &&
      policy !== "write_with_approval_read" &&
      policy !== "write_read"
    )
      throw usageError();
    return { action: "email_set", serverId, provider, accountId, policy, json };
  }
  if (arguments_[0] === "bug" || arguments_[0] === "feedback") {
    const bug = arguments_[0] === "bug";
    if (arguments_[1] !== (bug ? "report" : "send")) throw usageError();
    const { values, flags } = parseNamedOptions(arguments_.slice(2), {
      values: ["--title", "--body"],
      booleans: ["--json"],
    });
    const title = values["--title"]?.trim();
    const body = values["--body"]?.trim();
    if (!title || !body || [...title].length > 255 || [...body].length > 20000)
      throw usageError();
    return {
      action: "feedback",
      label: bug ? "bug" : "enhancement",
      title,
      body,
      json: flags.has("--json"),
    };
  }
  if (arguments_[0] === "git") {
    const operation = arguments_[1];
    if (operation === "repos") {
      const { flags } = parseNamedOptions(arguments_.slice(2), {
        values: [],
        booleans: ["--json"],
      });
      return { action: "git_repos", json: flags.has("--json") };
    }
    if (operation !== "list" && operation !== "set" && operation !== "remove")
      throw usageError();
    const serverId = normalizeUuid(requiredPositional(arguments_, 2));
    if (operation === "list") {
      const { flags } = parseNamedOptions(arguments_.slice(3), {
        values: [],
        booleans: ["--json"],
      });
      return { action: "git_list", serverId, json: flags.has("--json") };
    }
    const rawRepositoryId = requiredPositional(arguments_, 3);
    const repositoryId = Number(rawRepositoryId);
    if (
      !/^[1-9][0-9]*$/.test(rawRepositoryId) ||
      !Number.isSafeInteger(repositoryId)
    )
      throw usageError();
    const { values, flags } = parseNamedOptions(arguments_.slice(4), {
      values:
        operation === "set"
          ? ["--issues", "--contents", "--pull-requests", "--workflows"]
          : [],
      booleans: ["--json"],
    });
    const json = flags.has("--json");
    if (operation === "remove")
      return { action: "git_remove", serverId, repositoryId, json };
    const workflows = values["--workflows"];
    if (workflows !== "none" && workflows !== "write") throw usageError();
    return {
      action: "git_set",
      serverId,
      repositoryId,
      json,
      permissions: {
        issues: gitAccessLevel(values["--issues"]),
        contents: gitAccessLevel(values["--contents"]),
        pull_requests: gitAccessLevel(values["--pull-requests"]),
        workflows,
      },
    };
  }
  const workspaceGroup =
    arguments_[0] === "workspaces" || arguments_[0] === "servers";
  if (arguments_[0] === "workspaces" && arguments_[1] === "claim") {
    const { flags } = parseNamedOptions(arguments_.slice(2), {
      values: [],
      booleans: ["--confirm", "--json"],
    });
    if (!flags.has("--confirm"))
      throw usageError(
        "Claim one Lite workspace free for two days without a credit card. Your trial starts when you claim. Add a card for five more free days, then Lite renews at $29/month unless canceled. To claim, run teamclaws workspaces claim --confirm.",
      );
    return { action: "workspace_claim", json: flags.has("--json") };
  }
  if (workspaceGroup && arguments_[1] === "upgrade") {
    const status = arguments_[2] === "status";
    const position = status ? 3 : 2;
    const target = parsePairingTarget(requiredPositional(arguments_, position));
    const { values, flags } = parseNamedOptions(
      arguments_.slice(position + 1),
      {
        values: status ? ["--run-id"] : [],
        booleans: status ? ["--json"] : ["--no-wait", "--json"],
      },
    );
    const runId = values["--run-id"];
    if (runId !== undefined && !isUpgradeRunId(runId)) throw usageError();
    return {
      action: "servers_upgrade",
      json: flags.has("--json"),
      target,
      operation: status
        ? { kind: "status", ...(runId ? { runId } : {}) }
        : { kind: "start", noWait: flags.has("--no-wait") },
    };
  }
  if (workspaceGroup && arguments_[1] === "update") {
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
    const target = arguments_[1];
    if (!target || target.startsWith("-")) {
      throw usageError(
        "Missing required workspace target. Use a workspace ID or the full HTTPS workspace URL.",
      );
    }
    let command: string | undefined;
    let json = false;
    for (let index = 2; index < arguments_.length; index += 1) {
      const option = arguments_[index];
      if (option === "--command" && command === undefined) {
        command = arguments_[++index];
        if (command === undefined || command.length === 0)
          throw usageError("Provide a value for --command.");
      } else if (option === "--json" && !json) json = true;
      else throw usageError();
    }
    if (command === undefined)
      throw usageError("Missing required --command <text>.");
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
  if (args[0] === "users" && args[1] === "remove" && args.length === 4) {
    const target = parsePairingTarget(requiredPositional(args, 2));
    const email = requiredPositional(args, 3).trim().toLowerCase();
    if (!email || email.length > 254) throw usageError();
    return { action: "users_remove", json, target, email };
  }
  if (args[0] === "users" && args[1] === "add") {
    const target = parsePairingTarget(requiredPositional(args, 2));
    const email = requiredPositional(args, 3).trim().toLowerCase();
    const options = parseNamedOptions(args.slice(4), {
      values: [],
      booleans: ["--sudo"],
    });
    if (!email || email.length > 254) throw usageError();
    return {
      action: "users_add",
      json,
      target,
      email,
      role: "superuser",
      sudoEnabled: options.flags.has("--sudo"),
    };
  }
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h")
    return { action: "help", json };
  if (args[0] === "--version" || args[0] === "-v")
    return { action: "version", json };
  if (args[0] === "update" && args.length === 1)
    return { action: "update", json };
  if (args[0] === "login") {
    if (args.length === 1)
      throw new TeamClawsError(
        "invalid_command",
        "Ask the user for their TeamClaws email address, then run teamclaws login <email>.",
        { exitCode: 2 },
      );
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
  if (
    (args[0] === "workspaces" || args[0] === "servers") &&
    args[1] === "list" &&
    args.length === 2
  ) {
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

function gitAccessLevel(value: string | undefined): GitAccessLevel {
  if (value === "none" || value === "read" || value === "write") return value;
  throw usageError();
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
): Promise<ServerSummary> {
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
        ? "No TeamClaws workspaces are available to this account. Run teamclaws workspaces claim to see the free Lite trial terms, or visit https://teamclaws.com/app/."
        : "No pairing-ready TeamClaws workspaces are available. Check existing workspaces at https://teamclaws.com/app/; this does not mean you need to purchase another.",
      { exitCode: 4 },
    );
  }
  const interactive =
    io?.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (json || !interactive) {
    throw new TeamClawsError(
      "server_selection_required",
      "Choose a workspace by alias from `teamclaws workspaces list`, then provide its stable workspace ID after the user agrees to pair.",
      { exitCode: 4 },
    );
  }
  output.servers(servers);
  const selected = await promptForServer(
    servers,
    io?.input ?? process.stdin,
    io?.stdout ?? process.stdout,
  );
  return selected;
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

const SIGNUP_VERIFY_USAGE = "teamclaws signup verify --code-stdin [--json]";
const SIGNUP_CODE_INPUT =
  "Use the same CLI profile you started signup with. Send the emailed code followed by a newline through your execution tool's non-interactive stdin (non-TTY). Keep the code out of command arguments, shell text (including heredocs and here-strings), chat, logs, and files.";

async function readSignupCode(
  input: NodeJS.ReadableStream,
  signal?: AbortSignal,
): Promise<string> {
  if ((input as NodeJS.ReadStream).isTTY) throw usageError(SIGNUP_CODE_INPUT);
  const reader = createInterface({
    input,
    terminal: false,
    ...(signal ? { signal } : {}),
  });
  try {
    for await (const line of reader) return line;
    if (signal?.aborted)
      throw new TeamClawsError("cancelled", "Signup was cancelled.", {
        exitCode: 8,
      });
    throw usageError(SIGNUP_CODE_INPUT);
  } finally {
    reader.close();
  }
}

function usageError(
  message = "Run `teamclaws --help` for supported commands.",
): TeamClawsError {
  return new TeamClawsError("invalid_command", message, {
    exitCode: 2,
  });
}

export function helpText(): string {
  return `TeamClaws ${PACKAGE_VERSION}\n\nUsage:\n  teamclaws files link <target> --path <file> [--json]\n  teamclaws projects list <target> [--json]\n  teamclaws projects create <target> --path <directory> [--create-directory] --request-id <uuid> [--json]\n  teamclaws projects rename <target> --project-id <id> [--name <name>] [--path <directory>] --request-id <uuid> [--json]\n  teamclaws projects delete <target> --project-id <id> [--delete-directory] --request-id <uuid> [--json]\n  teamclaws projects hide|show <target> --project-id <id> --request-id <uuid> [--json]\n  teamclaws update [--json]\n  teamclaws shell <workspace-id-or-https-url> --command <text> [--json]\n  teamclaws users add <target> <email> [--sudo] [--json]\n  teamclaws users remove <target> <email> [--json]\n  teamclaws users list <target> [--json]\n  teamclaws login <email> [--json]\n  teamclaws signup <email> [--json]\n  teamclaws signup verify --code-stdin [--json]\n  teamclaws auth status [--json]\n  teamclaws logout [--revoke] [--json]\n  teamclaws workspaces list [--json]\n  teamclaws workspaces claim --confirm [--json]\n  teamclaws workspaces upgrade <target> [--no-wait] [--json]\n  teamclaws workspaces upgrade status <target> [--run-id <id>] [--json]\n  teamclaws workspaces update <workspace-id> [--name <text>] [--description <text>] [--json]\n  teamclaws email accounts [--json]\n  teamclaws email list <workspace-id> [--json]\n  teamclaws email set <workspace-id> <google|microsoft> <account-id> --policy <read_only|write_with_approval_read|write_read> [--json]\n  teamclaws email remove <workspace-id> <google|microsoft> <account-id> [--json]\n  teamclaws bug report --title <text> --body <text> [--json]\n  teamclaws feedback send --title <text> --body <text> [--json]\n  teamclaws git repos [--json]\n  teamclaws git list <workspace-id> [--json]\n  teamclaws git set <workspace-id> <repository-id> --issues <none|read|write> --contents <none|read|write> --pull-requests <none|read|write> --workflows <none|write> [--json]\n  teamclaws git remove <workspace-id> <repository-id> [--json]\n  teamclaws pair status <workspace-id-or-https-url> [--json]\n  teamclaws pair [workspace-id-or-https-url] [--no-open] [--json]\n  teamclaws chat list <target> [--json]\n  teamclaws chat history <target> [--json]\n  teamclaws chat messages <target> --chat-id <uuid> [--after-message-id <n>] [--json]\n  teamclaws chat capabilities <target> [--json]\n  teamclaws chat start <target> --message <text> [selection options] [--json]\n  teamclaws chat send <target> --session-id <uuid> --message <text> [--json]\n  teamclaws chat watch <target> --session-id <uuid> --request-id <uuid> [resume cursors] [--json]\n\nPair status performs one bounded direct verification and stops. Pairing grants the standard host-issued credential. Chat commands use that credential directly against the selected workspace.\n`;
}
