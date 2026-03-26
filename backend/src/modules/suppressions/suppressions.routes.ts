import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { successResponse } from '../../shared/response.js';
import { createSuppression, listSuppressions } from './suppressions.service.js';
import type { Request, Response, NextFunction } from 'express';
import type { ZoneAccessContext } from '../../shared/types.js';

const router = Router();

function getZoneContext(req: Request): ZoneAccessContext {
  return { userId: req.user!.userId, role: req.user!.role, zoneIds: req.user!.zoneIds };
}

// POST /sensors/:sensorId/suppressions
router.post('/:sensorId/suppressions', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getZoneContext(req);
    const body = req.body as { start_time?: string; end_time?: string; note?: string };
    if (!body.start_time || !body.end_time) {
      res.status(400).json({ data: null, meta: {}, error: { code: 'VALIDATION_ERROR', message: 'start_time and end_time are required' } });
      return;
    }
    const data = await createSuppression(ctx, req.params.sensorId as string, {
      start_time: body.start_time,
      end_time: body.end_time,
      note: body.note,
    });
    res.status(201).json(successResponse(data));
  } catch (err) {
    next(err);
  }
});

// GET /sensors/:sensorId/suppressions
router.get('/:sensorId/suppressions', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getZoneContext(req);
    const activeOnly = req.query.active_only === 'true';
    const data = await listSuppressions(ctx, req.params.sensorId as string, activeOnly);
    res.json(successResponse(data));
  } catch (err) {
    next(err);
  }
});

export default router;
