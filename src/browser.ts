import { spawn } from "node:child_process";

export async function openExternalBrowser(url: string): Promise<boolean> {
  const command = browserCommand(url);
  if (!command) return false;
  return await new Promise((resolve) => {
    const child = spawn(command.executable, command.arguments, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { executable: string; arguments: string[] } | undefined {
  if (platform === "darwin") return { executable: "open", arguments: [url] };
  if (platform === "win32") {
    return {
      executable: "rundll32.exe",
      arguments: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (platform === "linux") return { executable: "xdg-open", arguments: [url] };
  return undefined;
}
