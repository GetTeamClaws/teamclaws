import { parseArguments, run, type AppDependencies } from "./app.js";
import { checkRelease, releaseNotice, type ReleaseCheck } from "./update.js";

export async function runCli(
  args: string[],
  dependencies: AppDependencies = {},
  signal?: AbortSignal,
  check: (signal?: AbortSignal) => Promise<ReleaseCheck> = checkRelease,
): Promise<number> {
  // No persistent cache: every executable invocation checks before dispatch.
  let releaseCheck: ReleaseCheck;
  try {
    releaseCheck = await check(signal);
  } catch {
    releaseCheck = { status: "unavailable" };
  }
  if (releaseCheck.status === "available") {
    let json = args.includes("--json");
    try {
      json = parseArguments(args).json;
    } catch {
      /* Match usage errors. */
    }
    const { release } = releaseCheck;
    const message = releaseNotice(release);
    (dependencies.io?.stderr ?? process.stderr).write(
      json
        ? `${JSON.stringify({ schema_version: 1, event: "update_available", version: release.version, published_at: release.publishedAt, available_date: release.date, update_command: "teamclaws update", message })}\n`
        : `${message}\n`,
    );
  }
  return run(args, { ...dependencies, releaseCheck }, signal);
}
