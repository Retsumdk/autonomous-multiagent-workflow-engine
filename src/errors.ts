export type WorkflowErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STATE"
  | "CONFIG"
  | "CORRUPTION"
  | "UNAUTHORIZED";

const HTTP_STATUS: Record<WorkflowErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STATE: 409,
  CONFIG: 400,
  CORRUPTION: 500,
  UNAUTHORIZED: 401,
};

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    if (details !== undefined) this.details = details;
  }
}

export function isWorkflowError(value: unknown): value is WorkflowError {
  return value instanceof WorkflowError;
}
