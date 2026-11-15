import { NETWORK_ERROR } from "./result";

export interface ConnectionStatus {
  lastOkAt: number | null;
  lastError: string | null;
  authRequired: boolean;
}

type Listener = () => void;

/**
 * What the shell's freshness dot and the token gate read. 200 and 304 both prove the server is
 * up and the token is accepted; the snapshot object only changes on a real transition, so a
 * server that stays down does not re-render the page every poll.
 */
export class StatusStore {
  private status: ConnectionStatus = { lastOkAt: null, lastError: null, authRequired: false };
  private readonly listeners = new Set<Listener>();

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly get = (): ConnectionStatus => this.status;

  ok(now: number = Date.now()): void {
    this.set({ lastOkAt: now, lastError: null, authRequired: false });
  }

  network(): void {
    this.fail(NETWORK_ERROR);
  }

  fail(message: string): void {
    if (this.status.lastError === message) {
      return;
    }
    this.set({ ...this.status, lastError: message });
  }

  requireAuth(): void {
    if (!this.status.authRequired) {
      this.set({ ...this.status, authRequired: true });
    }
  }

  clearAuth(): void {
    if (this.status.authRequired) {
      this.set({ ...this.status, authRequired: false });
    }
  }

  private set(next: ConnectionStatus): void {
    this.status = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const connection = new StatusStore();
