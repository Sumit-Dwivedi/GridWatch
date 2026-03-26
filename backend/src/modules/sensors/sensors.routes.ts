import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { successResponse } from '../../shared/response.js';
import { getSensorDetail } from './sensors.service.js';
import type { Request, Response, NextFunction } from 'express';
import type { ZoneAccessContext } from '../../shared/types.js';

const router = Router();

function getZoneContext(req: Request): ZoneAccessContext {
  return { userId: req.user!.userId, role: req.user!.role, zoneIds: req.user!.zoneIds };
}

// GET /sensors/:sensorId
router.get('/:sensorId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getZoneContext(req);
    const data = await getSensorDetail(ctx, req.params.sensorId as string);
    res.json(successResponse(data));
  } catch (err) {
    next(err);
  }
});

export default router;
