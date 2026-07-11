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
  /** A destroy() call threw during eviction/shutdown — logged, not fatal. */
  onEvictError?: (error: Error, username: string, sandboxId: string) => void;
}

/**
 * Owns the user -> live-sandbox mapping, the reconnect grace window, and TTL
 * eviction. One sandbox per username at a time. `clock` is injectable so
 * tests can drive grace/TTL expiry deterministically without faking real
 * socket timers (see tests/session-manager.test.ts).
 */
export class SessionManager {
  private records = new Map<string, Record_>();
  // Dedupes concurrent connect() calls for the same username (e.g. two SSH
  // channels opened back-to-back) so only one provision() happens and both
  // callers get the same sandbox, instead of racing two independent
  // provisions where the second silently overwrites — and leaks — the first.
  private pendingConnects = new Map<string, Promise<Sandbox>>();
  private janitorTimer?: NodeJS.Timeout;
  private clock: () => number;

  constructor(private opts: SessionManagerOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
  }

  /** Reuses the live sandbox if this user disconnected within grace (or is already connected); otherwise provisions fresh. */
  async connect(username: string, template: Template, driver: SandboxDriver): Promise<Sandbox> {
    const pending = this.pendingConnects.get(username);
    if (pending) return pending;

    const promise = this.doConnect(username, template, driver);
    this.pendingConnects.set(username, promise);
    try {
      return await promise;
    } finally {
      this.pendingConnects.delete(username);
    }
  }

  private async doConnect(username: string, template: Template, driver: SandboxDriver): Promise<Sandbox> {
    const existing = this.records.get(username);
    if (existing) {
      // Either a within-grace reconnect, or a second concurrent session for
      // the same user (e.g. a second terminal) — either way, reuse rather
      // than silently clobbering the map entry the first session still owns.
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
    const toEvict: Array<[string, Record_, JanitorEvent['type']]> = [];

    for (const [username, rec] of this.records) {
      const graceMs = rec.template.reconnectGraceSeconds * 1000;
      const ttlMs = rec.template.maxTtlSeconds * 1000;
      const idleExpired = rec.lastDisconnectedAt !== null && now - rec.lastDisconnectedAt >= graceMs;
      const ttlExpired = now - rec.createdAt >= ttlMs;
      if (idleExpired || ttlExpired) {
        // Remove from `records` BEFORE awaiting destroy() below: if a
        // reconnect races in while teardown is in flight, it must see no
        // record and provision a fresh sandbox, not reuse the one being
        // destroyed out from under it.
        this.records.delete(username);
        toEvict.push([username, rec, idleExpired ? 'evicted-idle' : 'evicted-ttl']);
      }
    }

    for (const [username, rec, type] of toEvict) {
      try {
        await rec.driver.destroy(rec.sandbox);
        this.opts.onEvict?.({ type, sandboxId: rec.sandbox.id, username });
      } catch (err) {
        // One failing teardown must not stop the rest of the sweep (or crash
        // the process via an unhandled rejection from the setInterval tick).
        this.opts.onEvictError?.(err as Error, username, rec.sandbox.id);
      }
    }
  }

  /** Destroys every live sandbox — used on SIGTERM and in the SIGTERM-equivalent test. */
  async shutdown(): Promise<void> {
    this.stop();
    const recs = [...this.records.values()];
    this.records.clear();
    for (const rec of recs) {
      try {
        await rec.driver.destroy(rec.sandbox);
      } catch (err) {
        this.opts.onEvictError?.(err as Error, rec.username, rec.sandbox.id);
      }
    }
  }
}
