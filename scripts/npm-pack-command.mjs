import { isAbsolute } from "node:path";
import process from "node:process";

export function npmPackInvocation({
  destination,
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
}) {
  if (typeof execPath !== "string" || !isAbsolute(execPath)) {
    throw new Error(
      "package verification requires an absolute process.execPath",
    );
  }
  if (typeof npmExecPath !== "string" || !isAbsolute(npmExecPath)) {
    throw new Error("package verification requires an absolute npm_execpath");
  }
  if (typeof destination !== "string" || !isAbsolute(destination)) {
    throw new Error(
      "package verification requires an absolute pack destination",
    );
  }

  return {
    command: execPath,
    args: [npmExecPath, "pack", "--json", "--pack-destination", destination],
  };
}
