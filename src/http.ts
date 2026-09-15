import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RESPONSE_LIMIT_BYTES,
  MAX_ERROR_MESSAGE_LENGTH,
} from "./constants.js";
import { TeamClawsError } from "./errors.js";
import { isObject } from "./validation.js";

export type FetchLike = typeof fetch;

export type JsonRequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  form?: URLSearchParams;
  timeoutMs?: number;
  responseLimitBytes?: number;
  signal?: AbortSignal;
};

export type JsonResponse = {
  status: number;
  headers: Headers;
  body: unknown;
};

export async function requestJson(
  fetcher: FetchLike,
  url: string,
  options: JsonRequestOptions = {},
): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  const headers = new Headers({
    Accept: "application/json",
    ...options.headers,
  });
  let body: string | undefined;
  if (options.form) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = options.form.toString();
  } else if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new TeamClawsError(
        "network_timeout",
        "TeamClaws did not respond in time.",
        {
          retryable: true,
          exitCode: 5,
        },
      );
    }
    void error;
    throw new TeamClawsError(
      "network_error",
      "TeamClaws could not be reached securely.",
      {
        retryable: true,
        exitCode: 5,
      },
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const limit = options.responseLimitBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES;
  if (contentLength > limit) {
    throw new TeamClawsError(
      "response_too_large",
      "TeamClaws returned an oversized response.",
      {
        exitCode: 9,
      },
    );
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  if (contentType !== "application/json") {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned a non-JSON response.",
      {
        exitCode: 9,
      },
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new TeamClawsError(
      "response_too_large",
      "TeamClaws returned an oversized response.",
      {
        exitCode: 9,
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new TeamClawsError(
      "invalid_response",
      "TeamClaws returned invalid JSON.",
      { exitCode: 9 },
    );
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

export function errorFromResponse(
  response: JsonResponse,
  fallbackCode: string,
): TeamClawsError {
  if (!isObject(response.body)) {
    return new TeamClawsError(fallbackCode, "TeamClaws rejected the request.", {
      retryable: response.status >= 500,
      exitCode: response.status === 401 ? 3 : 5,
    });
  }
  const protocolError = isObject(response.body.error)
    ? response.body.error
    : response.body;
  const code = safeProtocolString(protocolError.code, fallbackCode, 80);
  const message = safeProtocolString(
    protocolError.message ?? protocolError.error,
    "TeamClaws rejected the request.",
    MAX_ERROR_MESSAGE_LENGTH,
  );
  const retryable = protocolError.retryable === true;
  const retryAfter = Number(protocolError.retry_after_seconds);
  return new TeamClawsError(code, message, {
    retryable,
    ...(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86_400
      ? { retryAfterSeconds: retryAfter }
      : {}),
    exitCode: response.status === 401 ? 3 : response.status === 429 ? 5 : 1,
  });
}

function safeProtocolString(
  value: unknown,
  fallback: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  )
    return fallback;
  if ([...value].some((character) => character.charCodeAt(0) < 0x20))
    return fallback;
  return value;
}
