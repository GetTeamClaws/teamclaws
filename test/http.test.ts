import { describe, expect, it, vi } from "vitest";

import { TeamClawsError } from "../src/errors.js";
import { errorFromResponse, requestJson, type FetchLike } from "../src/http.js";
import { jsonResponse } from "./helpers.js";

describe("bounded JSON transport", () => {
  it("sends JSON without following redirects", async () => {
    const calls: RequestInit[] = [];
    const fetcher: FetchLike = vi.fn(async (_url, init) => {
      calls.push(init ?? {});
      return jsonResponse({ ok: true }, 201);
    });
    const response = await requestJson(fetcher, "https://example.com/api", {
      method: "POST",
      body: { safe: true },
      headers: { "X-Test": "yes" },
    });
    expect(response.status).toBe(201);
    expect(calls[0]?.redirect).toBe("error");
    expect(calls[0]?.body).toBe('{"safe":true}');
    expect(new Headers(calls[0]?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it.each([
    new Response("text", { headers: { "Content-Type": "text/plain" } }),
    new Response("not-json", {
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Content-Length": "1000" },
    }),
  ])("rejects unsafe or malformed responses", async (response) => {
    const fetcher: FetchLike = vi.fn(async () => response.clone());
    await expect(
      requestJson(fetcher, "https://example.com", { responseLimitBytes: 20 }),
    ).rejects.toBeInstanceOf(TeamClawsError);
  });

  it("maps transport failures to a safe retryable error", async () => {
    const fetcher: FetchLike = vi.fn(async () => {
      throw new Error("secret low-level detail");
    });
    await expect(
      requestJson(fetcher, "https://example.com"),
    ).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
      message: "TeamClaws could not be reached securely.",
    });
  });

  it("maps bounded protocol error fields without accepting control characters", () => {
    const headers = new Headers({ "Content-Type": "application/json" });
    expect(
      errorFromResponse(
        {
          status: 429,
          headers,
          body: {
            code: "rate_limited",
            message: "Try again later.",
            retryable: true,
            retry_after_seconds: 60,
          },
        },
        "failed",
      ),
    ).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 60,
      exitCode: 5,
    });
    expect(
      errorFromResponse(
        {
          status: 429,
          headers,
          body: {
            request_id: "22222222-2222-4222-8222-222222222222",
            error: {
              code: "rate_limited",
              message: "Try again later.",
              retryable: true,
              retry_after_seconds: 45,
            },
          },
        },
        "failed",
      ),
    ).toMatchObject({
      code: "rate_limited",
      message: "Try again later.",
      retryAfterSeconds: 45,
    });
    expect(
      errorFromResponse(
        {
          status: 400,
          headers,
          body: { code: "bad\ncode", message: "secret\nheader" },
        },
        "failed",
      ),
    ).toMatchObject({
      code: "failed",
      message: "TeamClaws rejected the request.",
    });
  });
});
