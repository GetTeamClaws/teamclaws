export type ErrorDetails = {
  connectUrl?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  exitCode?: number;
};

export class TeamClawsError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly exitCode: number;
  readonly connectUrl: string | undefined;

  constructor(code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "TeamClawsError";
    this.code = code;
    this.retryable = details.retryable ?? false;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.exitCode = details.exitCode ?? 1;
    this.connectUrl = details.connectUrl;
  }
}

export function safeError(error: unknown): TeamClawsError {
  if (error instanceof TeamClawsError) return error;
  return new TeamClawsError(
    "unexpected_error",
    "TeamClaws could not complete the command. Try again.",
    { exitCode: 1 },
  );
}
