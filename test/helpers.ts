import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Writable } from "../src/output.js";

export class MemoryWritable implements Writable {
  value = "";

  write(chunk: string): boolean {
    this.value += chunk;
    return true;
  }
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export async function fixture(path: string): Promise<unknown> {
  const url = new URL(`./fixtures/${path}`, import.meta.url);
  return JSON.parse(await readFile(fileURLToPath(url), "utf8")) as unknown;
}

export const SERVER_ID = "11111111-1111-4111-8111-111111111111";
export const DEVICE_ID = "55555555-5555-4555-8555-555555555555";
export const USER_ID = "44444444-4444-4444-8444-444444444444";

export function readyHandoff(
  origin = "https://workspace.example.com",
): Record<string, unknown> {
  return {
    schema_version: 1,
    contract_version: 1,
    status: "ready",
    reason_codes: [],
    skill_url: `${origin}/teamclaws-admin/device-chat-client/SKILL.md`,
    skill_name: "teamclaws-external-chat-client",
    bundle_sha256: "a".repeat(64),
    capabilities_url: "/teamclaws-admin/api/device-chat/v1/capabilities/",
    recommended_action: "load_skill",
  };
}
