export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
