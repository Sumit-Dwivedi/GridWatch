import { Router } from 'express';
import { ZodError } from 'zod';
import { ingestRequestSchema } from './ingest.schema.js';
import { ingestReadings } from './ingest.service.js';
import { requireAuth } from '../../middleware/auth.js';
import { successResponse, errorResponse } from '../../shared/response.js';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    let validated;
    try {
      validated = ingestRequestSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        res.status(400).json(errorResponse('VALIDATION_ERROR', details));
        return;
      }
      throw err;
    }

    const result = await ingestReadings(validated);
    res.status(202).json(successResponse(result));
  } catch (err) {
    next(err);
  }
});

export default router;
