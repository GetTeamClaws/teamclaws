import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type NpmPackInvocation = Readonly<{
  command: string;
  args: readonly string[];
}>;

type NpmPackCommandModule = Readonly<{
  npmPackInvocation: (options: {
    destination: string;
    execPath?: string;
    npmExecPath?: string;
  }) => NpmPackInvocation;
}>;

type ArchiveListingModule = Readonly<{
  archiveListingEntries: (listing: string) => readonly string[];
}>;

const REQUIRED_ARCHIVE_ENTRIES = [
  "package/dist/cli.js",
  "package/skills/teamclaws-pair/SKILL.md",
  "package/skills/teamclaws-login/SKILL.md",
  "package/LICENSE",
] as const;

async function loadCommandModule(): Promise<NpmPackCommandModule> {
  const moduleUrl = new URL("../scripts/npm-pack-command.mjs", import.meta.url)
    .href;
  return (await import(moduleUrl)) as NpmPackCommandModule;
}

async function loadArchiveListingModule(): Promise<ArchiveListingModule> {
  const moduleUrl = new URL("../scripts/archive-listing.mjs", import.meta.url)
    .href;
  return (await import(moduleUrl)) as ArchiveListingModule;
}

describe("packed-package npm launcher", () => {
  it("runs npm's CLI through the current Node executable", async () => {
    const { npmPackInvocation } = await loadCommandModule();
    const execPath = resolve("test-bin", "node");
    const npmExecPath = resolve("test-bin", "npm-cli.js");
    const destination = resolve("test-output", "package");

    expect(npmPackInvocation({ destination, execPath, npmExecPath })).toEqual({
      command: execPath,
      args: [npmExecPath, "pack", "--json", "--pack-destination", destination],
    });
  });

  it.each([
    ["missing npm_execpath", ""],
    ["relative npm_execpath", "npm-cli.js"],
  ])("fails clearly for %s", async (_label, npmExecPath) => {
    const { npmPackInvocation } = await loadCommandModule();

    expect(() =>
      npmPackInvocation({
        destination: resolve("test-output", "package"),
        execPath: process.execPath,
        npmExecPath,
      }),
    ).toThrow("package verification requires an absolute npm_execpath");
  });
});

describe("packed-package archive listing", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])(
    "recognizes exact required entries with %s records",
    async (_label, eol) => {
      const { archiveListingEntries } = await loadArchiveListingModule();
      const entries = archiveListingEntries(
        `${REQUIRED_ARCHIVE_ENTRIES.join(eol)}${eol}`,
      );

      for (const required of REQUIRED_ARCHIVE_ENTRIES) {
        expect(entries).toContain(required);
      }
    },
  );

  it("rejects prefix, suffix, and altered near-miss paths", async () => {
    const { archiveListingEntries } = await loadArchiveListingModule();
    const entries = archiveListingEntries(
      [
        "prefix/package/dist/cli.js",
        "package/skills/teamclaws-pair/SKILL.md.bak",
        "package/skills/teamclaws-login/SKILL",
        "package/LICENSE/",
      ].join("\r\n"),
    );

    for (const required of REQUIRED_ARCHIVE_ENTRIES) {
      expect(entries).not.toContain(required);
    }
  });
});
