/**
 * Transport abstraction.
 *
 * The protocol client is transport-agnostic so the exact same connection
 * state machine runs over:
 *   - raw TCP (Termux/Node CLI, via nodeTcp.ts)
 *   - a WebSocket bridge (browser, via wsBridge.ts)
 *   - an in-process scripted server (dashboard demo + tests, via simulated.ts)
 *
 * Transports are push-based and never block: bytes arrive through `onData`,
 * closure through `onClose`.
 */
export type TransportDataHandler = (bytes: Uint8Array) => void;
export type TransportCloseHandler = (info: { reason: string; error?: boolean }) => void;

export interface Transport {
  readonly kind: "tcp" | "websocket" | "simulated";
  /** Human-readable remote endpoint, for logs and the dashboard. */
  readonly endpoint: string;
  connect(): Promise<void>;
  send(bytes: Uint8Array): void;
  close(reason?: string): void;
  onData(handler: TransportDataHandler): void;
  onClose(handler: TransportCloseHandler): void;
}

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}
