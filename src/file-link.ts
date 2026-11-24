import type { BrokerClient } from "./broker.js";
import { TeamClawsError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { runShell } from "./shell.js";
import type { CredentialStore } from "./storage.js";
import type { TargetAuthorization } from "./target-authorization.js";
import type { PairingTarget } from "./types.js";
import { isObject } from "./validation.js";

// The production Files viewer uses this shared root, independent of shell HOME.
export function fileLinkCommand(path: string): string {
  if (!path || path.includes("\0"))
    throw new TeamClawsError("invalid_path", "A file path is required.");
  const encoded = Buffer.from(path, "utf8").toString("base64");
  return `python3 - <<'TEAMCLAWS_FILE_LINK'
import base64, json
from pathlib import Path
root = Path('/home/teamclaws_user').resolve(strict=True)
requested = Path(base64.b64decode('${encoded}').decode('utf-8'))
path = (requested if requested.is_absolute() else root / requested).resolve(strict=True)
relative = path.relative_to(root).as_posix()
if not path.is_file():
    raise ValueError('The requested path is not a regular file')
with path.open('rb') as stream:
    stream.read(1)
print(json.dumps({'path': relative}))
TEAMCLAWS_FILE_LINK`;
}

export async function fileLink(
  store: CredentialStore,
  fetcher: FetchLike,
  target: PairingTarget,
  path: string,
  authorization: TargetAuthorization,
  broker: BrokerClient,
  signal?: AbortSignal,
): Promise<{ url: string; path: string; verification: string }> {
  const command = fileLinkCommand(path);
  const inventory = await broker.servers(signal);
  const matches = inventory.servers.filter((server) =>
    "server_id" in target
      ? server.server_id === target.server_id
      : new URL(server.workspace_url).origin ===
        new URL(target.workspace_url).origin,
  );
  if (matches.length !== 1)
    throw new TeamClawsError(
      "target_unavailable",
      "Select an accessible workspace.",
    );
  const server = matches[0]!;
  const result = await runShell(
    store,
    fetcher,
    { server_id: server.server_id },
    command,
    authorization,
    broker,
    signal,
  );
  if (result.exit_code !== 0)
    throw new TeamClawsError(
      "file_unavailable",
      "The file could not be verified as readable within the viewer's shared workspace root. No link was generated.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  if (
    !isObject(parsed) ||
    typeof parsed.path !== "string" ||
    !parsed.path ||
    parsed.path.startsWith("/") ||
    parsed.path.split("/").some((part) => part === "..")
  )
    throw new TeamClawsError(
      "invalid_response",
      "Invalid file verification response.",
    );
  const url = new URL("/teamclaws-admin/", server.workspace_url);
  url.search = new URLSearchParams({
    new_chat: "1",
    panel: "files",
    file: parsed.path,
    view: "preview",
  }).toString();
  return {
    url: url.href,
    path: parsed.path,
    verification:
      "filesystem_readable; browser viewer authorization and rendering are checked when opened",
  };
}
