export function successResponse(data: unknown, meta: unknown = {}) {
  return { data, meta, error: null };
}

export function errorResponse(code: string, message: string) {
  return { data: null, meta: {}, error: { code, message } };
}
