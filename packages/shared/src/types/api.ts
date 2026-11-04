export type ApiSuccess<T> = { data: T; requestId?: string };
export type ApiFailure = {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
};
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  total?: number;
};
