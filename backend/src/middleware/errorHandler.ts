import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../shared/errors.js';
import { errorResponse } from '../shared/response.js';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(errorResponse(err.code, err.message));
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json(errorResponse('INTERNAL_ERROR', 'Internal server error'));
}
