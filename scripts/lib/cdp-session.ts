/**
 * A minimal Chrome DevTools Protocol client over Bun's built-in WebSocket.
 *
 * Exists so the demo recorder can drive a **visible** Chrome window: `chrome --screenshot`
 * implies headless, and this repo takes no dependencies, so neither Puppeteer nor Playwright is
 * an option. Bun ships a WebSocket client, and CDP is the rest.
 *
 * Only the handful of domains the recorder needs are wrapped; this is not a general client.
 */

interface CdpResponse {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
  readonly method?: string;
}

interface PendingCall {
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

interface ChromeTarget {
  readonly type?: string;
  readonly webSocketDebuggerUrl?: string;
}

export class CdpSession {
  private static readonly CALL_TIMEOUT_MS: number = 20_000;
  private static readonly TARGET_POLL_MS: number = 250;

  private readonly socket: WebSocket;
  private readonly pending: Map<number, PendingCall> = new Map();
  private nextId: number = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener("message", (event: MessageEvent): void => {
      this.onMessage(event);
    });
  }

  /** Waits for Chrome's debug endpoint to expose a page target, then attaches to it. */
  static async attach(port: number, timeoutMs: number): Promise<CdpSession> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "no page target";
    while (Date.now() < deadline) {
      const url = await CdpSession.pageSocketUrl(port);
      if (url !== null) {
        return new CdpSession(await CdpSession.open(url));
      }
      lastError = `no page target on port ${port}`;
      await Bun.sleep(CdpSession.TARGET_POLL_MS);
    }
    throw new Error(`could not attach to Chrome: ${lastError}`);
  }

  private static async pageSocketUrl(port: number): Promise<string | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!res.ok) {
        return null;
      }
      const targets = (await res.json()) as readonly ChromeTarget[];
      const page = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
      return page?.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  }

  private static open(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        resolve(socket);
      });
      socket.addEventListener("error", () => {
        reject(new Error(`websocket failed: ${url}`));
      });
    });
  }

  private onMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }
    let message: CdpResponse;
    try {
      message = JSON.parse(event.data) as CdpResponse;
    } catch {
      return;
    }
    if (message.id === undefined) {
      return;
    }
    const call = this.pending.get(message.id);
    if (call === undefined) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      call.reject(new Error(message.error.message ?? "cdp error"));
      return;
    }
    call.resolve(message.result ?? {});
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp call timed out: ${method}`));
      }, CdpSession.CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (result): void => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error): void => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
  }

  /** Evaluates an expression in the page and returns its JSON value. */
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const wrapper = result["result"] as { value?: unknown } | undefined;
    return wrapper?.value;
  }

  /** A PNG of the viewport, already decoded from the protocol's base64. */
  async screenshot(): Promise<Uint8Array> {
    const result = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const data = result["data"];
    if (typeof data !== "string") {
      throw new Error("screenshot returned no data");
    }
    return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  }

  close(): void {
    this.socket.close();
  }
}
