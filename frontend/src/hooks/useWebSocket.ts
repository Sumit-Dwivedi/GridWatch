import { useEffect, useRef, useState, useCallback } from 'react';
import { getWsUrl } from '../lib/api';

export interface WsEvent {
  type: string;
  data: Record<string, unknown>;
}

interface UseWebSocketOptions {
  token: string | null;
  onEvent: (event: WsEvent) => void;
}

export function useWebSocket({ token, onEvent }: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!token) return;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'connected') {
          onEventRef.current(msg);
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Reconnect after 3 seconds
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [token]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { connected };
}
