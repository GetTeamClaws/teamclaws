import { describe, expect, it } from "vitest";

import { browserCommand } from "../src/browser.js";

describe("external browser commands", () => {
  const url = "https://workspace.example.com/approve";

  it("uses argument arrays without a shell on supported systems", () => {
    expect(browserCommand(url, "darwin")).toEqual({
      executable: "open",
      arguments: [url],
    });
    expect(browserCommand(url, "linux")).toEqual({
      executable: "xdg-open",
      arguments: [url],
    });
    expect(browserCommand(url, "win32")).toEqual({
      executable: "rundll32.exe",
      arguments: ["url.dll,FileProtocolHandler", url],
    });
  });

  it("fails safely on an unsupported operating system", () => {
    expect(browserCommand(url, "freebsd")).toBeUndefined();
  });
});
