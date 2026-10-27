// WebSocket executor client: connect, keep-alive, reconnect, frame I/O.
// Protocol: GET /ws/executor?executorId&token (no handshake frame; auth on open).

import WebSocket from 'ws';
import type { ClientFrame, ExecutorInventory, ServerFrame, TaskDispatchFrame } from './frames.js';
import { decodeServerFrame } from './frames.js';

export interface WsClientHandlers {
  onDispatch: (frame: TaskDispatchFrame) => void;
  onFrame?: (frame: ServerFrame) => void;
  onStateChange?: (state: 'connecting' | 'online' | 'offline', detail?: string) => void;
  /** Current dispatch inventory, sampled for every HEARTBEAT. */
  getInventory?: () => ExecutorInventory;
  /** Reported on HEARTBEAT for platform diagnostics. */
  getVersion?: () => string;
  getModel?: () => string;
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
      this.send(this.buildHeartbeat());
      this.flushPending();
      this.startHeartbeat();
    });

    socket.on('message', (data) => {
      const raw = data.toString();
      const frame = decodeServerFrame(raw);
      if (!frame) {
        // Forward compat: log-and-ignore unknown downstream frames.
        try { this.log('info', `inbound unknown frame type=${(JSON.parse(raw) as { type?: string }).type ?? '?'}`); } catch { /* non-JSON */ }
        return;
      }
      this.handlers.onFrame?.(frame);
      if (frame.type === 'TASK_DISPATCH') this.handlers.onDispatch(frame);
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
      this.send(this.buildHeartbeat());
    }, HEARTBEAT_INTERVAL_MS);
  }

  private buildHeartbeat(): ClientFrame {
    const inventory = this.handlers.getInventory?.();
    const heartbeat: Record<string, unknown> = { type: 'HEARTBEAT' };
    if (this.handlers.getVersion) heartbeat.version = this.handlers.getVersion();
    if (this.handlers.getModel) heartbeat.model = this.handlers.getModel();
    // Capabilities declared on every heartbeat; the server gates frame content
    // on them (e.g. the TASK_DISPATCH signature block only ships when
    // TASK_PACKAGE_SIGNATURE_V1 is declared).
    const features: string[] = ['TASK_PACKAGE_SIGNATURE_V1'];
    if (inventory) {
      features.push('dispatch_inventory_v1');
      heartbeat.maxConcurrentDispatches = inventory.maxConcurrentDispatches;
      heartbeat.dispatchInventoryReady = inventory.dispatchInventoryReady;
      heartbeat.runningDispatchIds = [...inventory.runningDispatchIds];
      heartbeat.ownedDispatchIds = [...inventory.ownedDispatchIds];
      heartbeat.runningConversationTurnIds = [...inventory.runningConversationTurnIds];
      if (inventory.dispatchInventoryError !== undefined) heartbeat.dispatchInventoryError = inventory.dispatchInventoryError;
    }
    heartbeat.protocolFeatures = features;
    return heartbeat as unknown as ClientFrame;
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
