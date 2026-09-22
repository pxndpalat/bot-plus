export type ErrorKind =
  | "validation"
  | "unauthorized"
  | "conflict"
  | "transient_infrastructure"
  | "permanent_failure";

export interface ErrorDetails {
  readonly field?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly details?: ErrorDetails;

  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown; details?: ErrorDetails; retryable?: boolean }) {
    super(message, { cause: options?.cause });
    this.name = "AppError";
    this.kind = kind;
    this.retryable = options?.retryable ?? kind === "transient_infrastructure";
    this.details = options?.details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super("validation", message, { details, retryable: false });
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", details?: ErrorDetails) {
    super("unauthorized", message, { details, retryable: false });
    this.name = "UnauthorizedError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super("conflict", message, { details, retryable: false });
    this.name = "ConflictError";
  }
}

export class TransientInfrastructureError extends AppError {
  constructor(message: string, options?: { cause?: unknown; details?: ErrorDetails }) {
    super("transient_infrastructure", message, { ...options, retryable: true });
    this.name = "TransientInfrastructureError";
  }
}

export class PermanentFailureError extends AppError {
  constructor(message: string, options?: { cause?: unknown; details?: ErrorDetails }) {
    super("permanent_failure", message, { ...options, retryable: false });
    this.name = "PermanentFailureError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function errorKind(error: unknown): ErrorKind | undefined {
  return isAppError(error) ? error.kind : undefined;
}
