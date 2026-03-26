import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { successResponse } from '../../shared/response.js';
import { getSensorHistory } from './history.service.js';
import type { Request, Response, NextFunction } from 'express';
import type { ZoneAccessContext } from '../../shared/types.js';

const router = Router();

function getZoneContext(req: Request): ZoneAccessContext {
  return { userId: req.user!.userId, role: req.user!.role, zoneIds: req.user!.zoneIds };
}

// GET /sensors/:sensorId/history
router.get('/:sensorId/history', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getZoneContext(req);
    const result = await getSensorHistory(ctx, req.params.sensorId as string, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      cursor: req.query.cursor as string | undefined,
    });
    res.json(successResponse(result.data, result.meta));
  } catch (err) {
    next(err);
  }
});

export default router;
