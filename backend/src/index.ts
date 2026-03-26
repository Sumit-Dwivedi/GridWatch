import express from 'express';
import http from 'http';
import cors from 'cors';
import { config } from './config.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authenticateToken } from './middleware/auth.js';
import authRouter from './modules/auth/auth.routes.js';
import ingestRouter from './modules/ingest/ingest.routes.js';
import alertsRouter from './modules/alerts/alerts.routes.js';
import suppressionsRouter from './modules/suppressions/suppressions.routes.js';
import historyRouter from './modules/history/history.routes.js';
import dashboardRouter from './modules/dashboard/dashboard.routes.js';
import sensorsRouter from './modules/sensors/sensors.routes.js';
import { startReadingProcessor } from './workers/readingProcessor.js';
import { startSilenceDetector } from './scheduler/silenceDetector.js';
import { startEscalationScheduler } from './scheduler/escalationScheduler.js';
import { setupWebSocketServer } from './realtime/wsServer.js';
import { startOutboxPublisher } from './workers/outboxPublisher.js';
import './shared/types.js';
import './db/client.js';

const app = express();

app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(authenticateToken);

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/auth', authRouter);
app.use('/ingest', ingestRouter);
app.use('/alerts', alertsRouter);
app.use('/sensors', suppressionsRouter);   // /sensors/:sensorId/suppressions
app.use('/sensors', historyRouter);        // /sensors/:sensorId/history
app.use('/sensors', sensorsRouter);        // /sensors/:sensorId (must be after sub-routes)
app.use('/dashboard', dashboardRouter);    // /dashboard/sensors

// Error handler (must be last)
app.use(errorHandler);

const server = http.createServer(app);
setupWebSocketServer(server);

server.listen(config.port, () => {
  console.log(`GridWatch API running on port ${config.port}`);
  startReadingProcessor();
  startSilenceDetector();
  startEscalationScheduler();
  startOutboxPublisher();
});

export { app, server };
