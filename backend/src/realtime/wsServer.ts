import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import type { JwtUserPayload } from '../shared/types.js';

interface ExtWebSocket extends WebSocket {
  isAlive: boolean;
}

interface ConnectionMeta {
  userId: string;
  role: string;
  zoneIds: string[];
}

// Zone → set of connected WebSockets
const zoneSubscriptions = new Map<string, Set<ExtWebSocket>>();
// WebSocket → metadata
const connectionMeta = new Map<ExtWebSocket, ConnectionMeta>();

// Cache all zone IDs for supervisor subscriptions
let allZoneIds: string[] | null = null;

async function getAllZoneIds(): Promise<string[]> {
  if (allZoneIds) return allZoneIds;
  const { rows } = await pool.query('SELECT id FROM zones');
  allZoneIds = rows.map(r => r.id);
  return allZoneIds;
}

function addToZone(zoneId: string, ws: ExtWebSocket) {
  let set = zoneSubscriptions.get(zoneId);
  if (!set) {
    set = new Set();
    zoneSubscriptions.set(zoneId, set);
  }
  set.add(ws);
}

function removeConnection(ws: ExtWebSocket) {
  const meta = connectionMeta.get(ws);
  if (meta) {
    for (const zoneId of meta.zoneIds) {
      const set = zoneSubscriptions.get(zoneId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) zoneSubscriptions.delete(zoneId);
      }
    }
    connectionMeta.delete(ws);
  }
}

async function handleConnection(ws: ExtWebSocket, req: http.IncomingMessage) {
  // Parse token from query string
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Authentication required');
    return;
  }

  let user: JwtUserPayload;
  try {
    user = jwt.verify(token, config.jwtSecret) as JwtUserPayload;
  } catch {
    ws.close(4001, 'Authentication required');
    return;
  }

  // Determine zone subscriptions
  let subscribedZones: string[];
  if (user.role === 'supervisor') {
    subscribedZones = await getAllZoneIds();
  } else {
    subscribedZones = user.zoneIds;
  }

  // Setup heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Store metadata
  const meta: ConnectionMeta = {
    userId: user.userId,
    role: user.role,
    zoneIds: subscribedZones,
  };
  connectionMeta.set(ws, meta);

  // Subscribe to zones
  for (const zoneId of subscribedZones) {
    addToZone(zoneId, ws);
  }

  // Send welcome
  ws.send(JSON.stringify({
    type: 'connected',
    data: { userId: user.userId, subscribedZones },
  }));

  // Cleanup on close
  ws.on('close', () => {
    removeConnection(ws);
  });

  ws.on('error', () => {
    removeConnection(ws);
  });
}

export function broadcastToZone(zoneId: string, message: object): void {
  const subscribers = zoneSubscriptions.get(zoneId);
  if (!subscribers || subscribers.size === 0) return;

  const payload = JSON.stringify(message);
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export function setupWebSocketServer(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    handleConnection(ws as ExtWebSocket, req);
  });

  // Heartbeat ping every 30 seconds
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtWebSocket;
      if (!extWs.isAlive) {
        removeConnection(extWs);
        extWs.terminate();
        return;
      }
      extWs.isAlive = false;
      extWs.ping();
    });
  }, 30_000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  console.log('[ws] WebSocket server attached on /ws');
}
