import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { archiveListingEntries } from "./archive-listing.mjs";
import { npmPackInvocation } from "./npm-pack-command.mjs";

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "teamclaws-package-"));

try {
  const npmPack = npmPackInvocation({ destination: root });
  const { stdout: packOutput } = await run(npmPack.command, npmPack.args);
  const packed = JSON.parse(packOutput)[0];
  if (!packed?.filename) throw new Error("npm pack did not return a filename");
  const archive = join(root, packed.filename);
  const { stdout: listing } = await run("tar", ["-tf", archive]);
  const archiveEntries = archiveListingEntries(listing);
  for (const required of [
    "package/dist/cli.js",
    "package/skills/teamclaws-chat/SKILL.md",
    "package/skills/teamclaws-pair/SKILL.md",
    "package/skills/teamclaws-login/SKILL.md",
    "package/LICENSE",
  ]) {
    if (!archiveEntries.includes(required))
      throw new Error(`missing packed file: ${required}`);
  }
  const output = await execute(process.execPath, [
    join(process.cwd(), "dist/cli.js"),
    "--help",
  ]);
  if (output.code !== 0 || !output.stdout.includes("teamclaws pair")) {
    throw new Error("packed command-line entrypoint acceptance failed");
  }
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  if (packageJson.bin?.teamclaws !== "./dist/cli.js")
    throw new Error("invalid bin contract");
  const versionOutput = await execute(process.execPath, [
    join(process.cwd(), "dist/cli.js"),
    "--version",
  ]);
  if (
    versionOutput.code !== 0 ||
    versionOutput.stdout !== `${packageJson.version}\n`
  ) {
    throw new Error("package and command version do not match");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
