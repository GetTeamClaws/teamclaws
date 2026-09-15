import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe("repository checkout policy", () => {
  it("keeps formatted text LF on every platform", async () => {
    const paths = [
      ".github/workflows/ci.yml",
      "README.md",
      "package.json",
      "scripts/test-packed-package.mjs",
      "src/storage.ts",
      "test/storage.test.ts",
    ];
    const { stdout } = await execFile(
      "git",
      ["check-attr", "text", "eol", "--", ...paths],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    for (const path of paths) {
      expect(stdout).toContain(`${path}: text: auto`);
      expect(stdout).toContain(`${path}: eol: lf`);
    }
  });
});
