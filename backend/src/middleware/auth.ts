import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { UnauthorizedError, ForbiddenError } from '../shared/errors.js';
import type { JwtUserPayload } from '../shared/types.js';

export function authenticateToken(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = undefined;
    next();
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as JwtUserPayload;
    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      zoneIds: decoded.zoneIds,
    };
  } catch {
    req.user = undefined;
  }

  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(new UnauthorizedError('Authentication required'));
    return;
  }
  next();
}

export function requireRole(...roles: Array<'operator' | 'supervisor'>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError('Insufficient permissions'));
      return;
    }
    next();
  };
}
