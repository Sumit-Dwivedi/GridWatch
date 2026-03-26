import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { successResponse } from '../../shared/response.js';
import { listAlerts, getAlert, acknowledgeAlert, resolveAlert } from './alerts.service.js';
import type { Request, Response, NextFunction } from 'express';
import type { ZoneAccessContext } from '../../shared/types.js';

const router = Router();

function getZoneContext(req: Request): ZoneAccessContext {
  return {
    userId: req.user!.userId,
    role: req.user!.role,
    zoneIds: req.user!.zoneIds,
  };
}

// GET /alerts
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getZoneContext(req);
    const result = await listAlerts(ctx, {
      status: req.query.status as string | undefined,
      severity: req.query.severity as string | undefined,
      zone_id: req.query.zone_id as string | undefined,
      sensor_id: req.query.sensor_id as string | undefined,
      is_suppressed: req.query.is_suppressed as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      cursor: req.query.cursor as string | undefined,
    });
    res.json(successResponse(result.data, result.meta));
  } catch (err) {
    next(err);
  }
});

// GET /alerts/:alertId
router.get('/:alertId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getZoneContext(req);
    const alertId = parseInt(req.params.alertId as string, 10);
    if (isNaN(alertId)) {
      res.status(400).json({ data: null, meta: {}, error: { code: 'VALIDATION_ERROR', message: 'Invalid alert ID' } });
      return;
    }
    const data = await getAlert(ctx, alertId);
    res.json(successResponse(data));
  } catch (err) {
    next(err);
  }
});

// POST /alerts/:alertId/acknowledge
router.post('/:alertId/acknowledge', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getZoneContext(req);
    const alertId = parseInt(req.params.alertId as string, 10);
    if (isNaN(alertId)) {
      res.status(400).json({ data: null, meta: {}, error: { code: 'VALIDATION_ERROR', message: 'Invalid alert ID' } });
      return;
    }
    const data = await acknowledgeAlert(ctx, alertId, (req.body as { reason?: string })?.reason);
    res.json(successResponse(data));
  } catch (err) {
    next(err);
  }
});

// POST /alerts/:alertId/resolve
router.post('/:alertId/resolve', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getZoneContext(req);
    const alertId = parseInt(req.params.alertId as string, 10);
    if (isNaN(alertId)) {
      res.status(400).json({ data: null, meta: {}, error: { code: 'VALIDATION_ERROR', message: 'Invalid alert ID' } });
      return;
    }
    const data = await resolveAlert(ctx, alertId, (req.body as { reason?: string })?.reason);
    res.json(successResponse(data));
  } catch (err) {
    next(err);
  }
});

export default router;
