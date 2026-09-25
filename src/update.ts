import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PACKAGE_NAME, PACKAGE_VERSION } from "./constants.js";

export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
export const UPDATE_TIMEOUT_MS = 1500;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
export type Release = { version: string; publishedAt: string; date: string };
export type ReleaseCheck =
  | { status: "available"; release: Release }
  | { status: "current" }
  | { status: "unavailable" };

// Strict SemVer syntax; arbitrary-size numeric components avoid rounding.
function semver(
  value: unknown,
): { core: bigint[]; prerelease: boolean } | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  return match
    ? { core: match.slice(1, 4).map(BigInt), prerelease: !!match[4] }
    : null;
}

export function isNewerStable(version: string, current: string): boolean {
  const latest = semver(version);
  const installed = semver(current);
  if (!latest || latest.prerelease || !installed) return false;
  for (let index = 0; index < 3; index++) {
    if (latest.core[index]! !== installed.core[index]!)
      return latest.core[index]! > installed.core[index]!;
  }
  return installed.prerelease;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid metadata");
  return value as Record<string, unknown>;
}

export function parseRelease(metadata: unknown, now = Date.now()): Release {
  const packument = object(metadata);
  const version = object(packument["dist-tags"]).latest;
  const parsed = semver(version);
  if (
    packument.name !== PACKAGE_NAME ||
    typeof version !== "string" ||
    !parsed ||
    parsed.prerelease
  )
    throw new Error("Invalid release");
  const manifest = object(object(packument.versions)[version]);
  const dist = object(manifest.dist);
  const publishedAt = object(packument.time)[version];
  if (
    manifest.name !== PACKAGE_NAME ||
    manifest.version !== version ||
    manifest.deprecated ||
    dist.tarball !==
      `${OFFICIAL_REGISTRY}teamclaws/-/teamclaws-${version}.tgz` ||
    typeof dist.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity) ||
    typeof publishedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(publishedAt)
  )
    throw new Error("Invalid published release");
  const timestamp = Date.parse(publishedAt);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== publishedAt ||
    timestamp > now
  )
    throw new Error("Invalid publish time");
  const [year, month, day] = publishedAt.slice(0, 10).split("-");
  return { version, publishedAt, date: `${month}/${day}/${year}` };
}

export async function checkRelease(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  current = PACKAGE_VERSION,
): Promise<ReleaseCheck> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort();
      reject(new Error("Registry deadline"));
    }, UPDATE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      timeout,
      (async (): Promise<ReleaseCheck> => {
        const response = await fetcher(`${OFFICIAL_REGISTRY}${PACKAGE_NAME}`, {
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
          headers: { Accept: "application/json" },
        });
        if (!response.ok || !response.body)
          throw new Error("Registry unavailable");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_METADATA_BYTES)
              throw new Error("Metadata too large");
            chunks.push(value);
          }
        } finally {
          void reader.cancel().catch(() => {});
        }
        const release = parseRelease(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        );
        return isNewerStable(release.version, current)
          ? { status: "available", release }
          : { status: "current" };
      })(),
    ]);
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
    abort();
    signal?.removeEventListener("abort", abort);
  }
}

export function releaseNotice(release: Release): string {
  return `Version ${release.version} Available starting on ${release.date}. Use command teamclaws update to update as soon as possible.`;
}

const execute = promisify(execFile);
export type NpmRunner = (
  args: string[],
  timeout: number,
  signal?: AbortSignal,
) => Promise<string>;

// npm's JS entrypoint avoids cmd.exe interpolation and .cmd spawning on Windows.
export async function npmRunner(
  nodeExecutable = process.execPath,
  platform = process.platform,
): Promise<NpmRunner> {
  const nodeDirectory = dirname(nodeExecutable);
  const candidates =
    platform === "win32"
      ? [join(nodeDirectory, "node_modules/npm/bin/npm-cli.js")]
      : [
          join(nodeDirectory, "npm"),
          resolve(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js"),
        ];
  for (const candidate of candidates) {
    try {
      const entry = await realpath(candidate);
      const pkg = JSON.parse(
        await readFile(resolve(dirname(entry), "../package.json"), "utf8"),
      ) as { name?: string };
      if (pkg.name !== "npm" || basename(entry) !== "npm-cli.js") continue;
      return async (args, timeout, signal) => {
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
          if (
            /^npm_config_/i.test(key) ||
            /^(NODE_OPTIONS|NODE_PATH)$/i.test(key)
          )
            delete env[key];
        }
        // Distinct empty files avoid npm's rejection of loading the same file
        // as both user and global configuration. Prefix discovery is read-only
        // and retains user config; installation uses only the verified prefix.
        const scratch =
          args[0] === "install"
            ? await mkdtemp(join(tmpdir(), "teamclaws-npm-"))
            : undefined;
        try {
          const config: string[] = [];
          if (scratch) {
            for (const name of ["user", "global"]) {
              const path = join(scratch, `${name}.npmrc`);
              await writeFile(path, "");
              config.push(`--${name}config=${path}`);
            }
          }
          const { stdout } = await execute(
            nodeExecutable,
            [entry, ...config, ...args],
            {
              cwd: scratch ?? tmpdir(),
              env,
              timeout,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
              ...(signal ? { signal } : {}),
            },
          );
          return stdout;
        } finally {
          if (scratch) await rm(scratch, { recursive: true, force: true });
        }
      };
    } catch {
      /* Try the other supported npm layout. */
    }
  }
  throw new Error("npm is unavailable beside the running Node installation.");
}

export function installerArguments(version: string, prefix: string): string[] {
  if (!isAbsolute(prefix) || /[\r\n\0]/.test(prefix))
    throw new Error("Invalid installation prefix");
  if (!semver(version) || semver(version)!.prerelease)
    throw new Error("Invalid update version");
  return [
    "install",
    "--global",
    `--prefix=${prefix}`,
    `--registry=${OFFICIAL_REGISTRY}`,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--update-notifier=false",
    "--",
    `${PACKAGE_NAME}@${version}`,
  ];
}

export async function installRelease(
  release: Release,
  signal?: AbortSignal,
  runner?: NpmRunner,
  packageRoot = fileURLToPath(new URL("../", import.meta.url)),
  platform = process.platform,
): Promise<void> {
  if (!isNewerStable(release.version, PACKAGE_VERSION))
    throw new Error("Refusing an equal, older, or invalid release.");
  const npm = runner ?? (await npmRunner());
  const prefix = (await npm(["prefix", "--global"], 5000, signal)).trim();
  // Verify the active package is the actual global package under npm's reported
  // prefix. Source, npm link, local/npx, pnpm and mismatched npm installs fail.
  if (
    !prefix ||
    !/^(?:\/|[A-Za-z]:[\\/])/.test(prefix) ||
    /[\r\n\0]/.test(prefix)
  )
    throw new Error("Invalid npm global prefix.");
  const canonicalPrefix = await realpath(prefix);
  const expected =
    platform === "win32"
      ? join(canonicalPrefix, "node_modules", PACKAGE_NAME)
      : join(canonicalPrefix, "lib/node_modules", PACKAGE_NAME);
  const actual = await realpath(packageRoot);
  if (actual !== resolve(expected) || (await realpath(expected)) !== actual)
    throw new Error(
      "Unsupported installation: teamclaws update requires the active npm global installation. Update local, linked, npx, or managed installations with their original package manager.",
    );
  const pkg = JSON.parse(
    await readFile(join(actual, "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  if (pkg.name !== PACKAGE_NAME || pkg.version !== PACKAGE_VERSION)
    throw new Error("Active package identity does not match.");
  await npm(installerArguments(release.version, prefix), 120000, signal);
  const updated = JSON.parse(
    await readFile(join(actual, "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  if (updated.name !== PACKAGE_NAME || updated.version !== release.version)
    throw new Error(
      "npm finished but the installed version could not be verified.",
    );
}
