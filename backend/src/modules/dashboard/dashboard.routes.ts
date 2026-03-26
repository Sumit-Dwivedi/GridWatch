import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { successResponse } from '../../shared/response.js';
import { getDashboardSensors } from './dashboard.service.js';
import type { Request, Response, NextFunction } from 'express';
import type { ZoneAccessContext } from '../../shared/types.js';

const router = Router();

function getZoneContext(req: Request): ZoneAccessContext {
  return { userId: req.user!.userId, role: req.user!.role, zoneIds: req.user!.zoneIds };
}

// GET /dashboard/sensors
router.get('/sensors', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getZoneContext(req);
    const result = await getDashboardSensors(ctx, {
      zone_id: req.query.zone_id as string | undefined,
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      cursor: req.query.cursor as string | undefined,
    });
    res.json(successResponse(result.data, result.meta));
  } catch (err) {
    next(err);
  }
});

export default router;
