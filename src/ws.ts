// WebSocket executor client: connect, keep-alive, reconnect, frame I/O.
// Protocol: GET /ws/executor?executorId&token (no handshake frame; auth on open).

import WebSocket from 'ws';
import type { ClientFrame, ServerFrame } from './frames.js';
import { decodeServerFrame } from './frames.js';

export interface WsClientHandlers {
  onDispatch: (frame: ServerFrame) => void;
  onStateChange?: (state: 'connecting' | 'online' | 'offline', detail?: string) => void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class WsClient {
  private socket?: WebSocket;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private backoffMs = BACKOFF_INITIAL_MS;
  private stopped = false;
  /** Frames queued while offline are flushed after the next successful connect. */
  private readonly pending: ClientFrame[] = [];

  constructor(
    private readonly url: string,
    private readonly handlers: WsClientHandlers,
    private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.socket?.close(1000, 'awce shutdown');
  }

  send(frame: ClientFrame): void {
    const payload = JSON.stringify(frame);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
    } else {
      this.pending.push(frame);
      this.log('warn', `offline; frame ${frame.type} queued (queue=${this.pending.length})`);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.handlers.onStateChange?.('connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      this.backoffMs = BACKOFF_INITIAL_MS;
      this.handlers.onStateChange?.('online');
      // Immediate heartbeat: the platform's executor list derives ONLINE from
      // the persisted heartbeat timestamp, not from the WS session itself.
      this.send({ type: 'HEARTBEAT' });
      this.flushPending();
      this.startHeartbeat();
    });

    socket.on('message', (data) => {
      const frame = decodeServerFrame(data.toString());
      if (!frame) return; // unknown/no-op frames are ignored (forward compat)
      this.handlers.onDispatch(frame);
    });

    socket.on('error', (error) => {
      this.log('warn', `ws error: ${error.message}`);
    });

    const scheduleReconnect = () => {
      if (this.stopped) return;
      this.clearHeartbeat();
      this.handlers.onStateChange?.('offline');
      const wait = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      this.log('info', `reconnecting in ${wait}ms`);
      setTimeout(() => this.connect(), wait);
    };
    socket.on('close', scheduleReconnect);
    socket.on('error', () => { /* close always follows; reconnect handled there */ });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'HEARTBEAT' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private flushPending(): void {
    while (this.pending.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
      const frame = this.pending.shift();
      if (frame) this.socket.send(JSON.stringify(frame));
    }
  }
}
