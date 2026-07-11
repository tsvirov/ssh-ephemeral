import type { SandboxDriver, Sandbox, Template } from './driver.js';

interface Record_ {
  sandbox: Sandbox;
  template: Template;
  driver: SandboxDriver;
  username: string;
  createdAt: number;
  lastDisconnectedAt: number | null;
}

export interface JanitorEvent {
  type: 'evicted-idle' | 'evicted-ttl';
  sandboxId: string;
  username: string;
}

export interface SessionManagerOptions {
  janitorIntervalMs?: number;
  clock?: () => number;
  onEvict?: (event: JanitorEvent) => void;
}

/**
 * Owns the user -> live-sandbox mapping, the reconnect grace window, and TTL
 * eviction. One sandbox per username at a time. `clock` is injectable so
 * tests can drive grace/TTL expiry deterministically without faking real
 * socket timers (see tests/session-manager.test.ts).
 */
export class SessionManager {
  private records = new Map<string, Record_>();
  private janitorTimer?: NodeJS.Timeout;
  private clock: () => number;

  constructor(private opts: SessionManagerOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
  }

  /** Reuses the live sandbox if this user disconnected within grace; otherwise provisions fresh. */
  async connect(username: string, template: Template, driver: SandboxDriver): Promise<Sandbox> {
    const existing = this.records.get(username);
    if (existing && existing.lastDisconnectedAt !== null) {
      existing.lastDisconnectedAt = null;
      return existing.sandbox;
    }
    const sessionId = `${username}-${this.clock()}-${Math.random().toString(36).slice(2, 8)}`;
    const sandbox = await driver.provision(template, sessionId);
    this.records.set(username, {
      sandbox,
      template,
      driver,
      username,
      createdAt: this.clock(),
      lastDisconnectedAt: null,
    });
    return sandbox;
  }

  disconnect(username: string): void {
    const rec = this.records.get(username);
    if (rec) rec.lastDisconnectedAt = this.clock();
  }

  getSandbox(username: string): Sandbox | undefined {
    return this.records.get(username)?.sandbox;
  }

  start(): void {
    const interval = this.opts.janitorIntervalMs ?? 10_000;
    this.janitorTimer = setInterval(() => {
      void this.sweep();
    }, interval);
    this.janitorTimer.unref?.();
  }

  stop(): void {
    if (this.janitorTimer) clearInterval(this.janitorTimer);
    this.janitorTimer = undefined;
  }

  private async sweep(): Promise<void> {
    const now = this.clock();
    for (const [username, rec] of [...this.records.entries()]) {
      const graceMs = rec.template.reconnectGraceSeconds * 1000;
      const ttlMs = rec.template.maxTtlSeconds * 1000;
      const idleExpired = rec.lastDisconnectedAt !== null && now - rec.lastDisconnectedAt >= graceMs;
      const ttlExpired = now - rec.createdAt >= ttlMs;
      if (idleExpired || ttlExpired) {
        await rec.driver.destroy(rec.sandbox);
        this.records.delete(username);
        this.opts.onEvict?.({
          type: idleExpired ? 'evicted-idle' : 'evicted-ttl',
          sandboxId: rec.sandbox.id,
          username,
        });
      }
    }
  }

  /** Destroys every live sandbox — used on SIGTERM and in the SIGTERM-equivalent test. */
  async shutdown(): Promise<void> {
    this.stop();
    for (const rec of this.records.values()) {
      await rec.driver.destroy(rec.sandbox);
    }
    this.records.clear();
  }
}
