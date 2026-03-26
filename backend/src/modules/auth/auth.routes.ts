import { Router } from 'express';
import { login, getUserById } from './auth.service.js';
import { requireAuth } from '../../middleware/auth.js';
import { successResponse, errorResponse } from '../../shared/response.js';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      res.status(400).json(errorResponse('VALIDATION_ERROR', 'Email and password are required'));
      return;
    }

    const result = await login(email, password);
    res.status(200).json(successResponse(result));
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getUserById(req.user!.userId);
    res.status(200).json(successResponse(user));
  } catch (err) {
    next(err);
  }
});

export default router;
