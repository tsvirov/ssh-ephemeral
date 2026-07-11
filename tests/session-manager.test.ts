import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session-manager.js';
import type { Sandbox, SandboxDriver, Template } from '../src/driver.js';

class FakeDriver implements SandboxDriver {
  readonly name = 'local' as const;
  sandboxes = new Map<string, Sandbox>();
  destroyedIds: string[] = [];

  async provision(template: Template, sessionId: string): Promise<Sandbox> {
    const sb: Sandbox = { id: sessionId, templateName: template.name, createdAt: Date.now(), driverName: 'local', meta: {} };
    this.sandboxes.set(sessionId, sb);
    return sb;
  }
  async attach(): Promise<never> {
    throw new Error('not used in SessionManager unit tests');
  }
  async resize(): Promise<void> {}
  async destroy(sandbox: Sandbox): Promise<void> {
    this.sandboxes.delete(sandbox.id);
    this.destroyedIds.push(sandbox.id);
  }
  async list(): Promise<Sandbox[]> {
    return [...this.sandboxes.values()];
  }
}

function template(overrides: Partial<Template> = {}): Template {
  return { name: 'dev', driver: 'local', maxTtlSeconds: 3600, reconnectGraceSeconds: 60, ...overrides };
}

describe('SessionManager (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the same sandbox on reconnect within the grace window', async () => {
    const driver = new FakeDriver();
    const manager = new SessionManager({ janitorIntervalMs: 1000 });
    manager.start();
    const t = template({ reconnectGraceSeconds: 60 });

    const first = await manager.connect('alice', t, driver);
    manager.disconnect('alice');
    await vi.advanceTimersByTimeAsync(30_000); // within the 60s grace window

    const second = await manager.connect('alice', t, driver);

    expect(second.id).toBe(first.id);
    expect(driver.destroyedIds).toHaveLength(0);
    manager.stop();
  });

  it('destroys the sandbox once the reconnect grace period elapses', async () => {
    const driver = new FakeDriver();
    const manager = new SessionManager({ janitorIntervalMs: 1000 });
    manager.start();
    const t = template({ reconnectGraceSeconds: 10 });

    const sb = await manager.connect('bob', t, driver);
    manager.disconnect('bob');
    await vi.advanceTimersByTimeAsync(15_000); // past grace + a janitor tick

    expect(driver.destroyedIds).toContain(sb.id);
    expect(await driver.list()).toHaveLength(0);
    manager.stop();
  });

  it('destroys the sandbox once maxTtlSeconds elapses, even while still connected', async () => {
    const driver = new FakeDriver();
    const manager = new SessionManager({ janitorIntervalMs: 1000 });
    manager.start();
    const t = template({ maxTtlSeconds: 20, reconnectGraceSeconds: 3600 });

    const sb = await manager.connect('carol', t, driver);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(driver.destroyedIds).toContain(sb.id);
    manager.stop();
  });

  it('shutdown (SIGTERM equivalent) destroys every live sandbox regardless of grace/ttl', async () => {
    const driver = new FakeDriver();
    const manager = new SessionManager({ janitorIntervalMs: 1000 });
    manager.start();
    const t = template();

    await manager.connect('dave', t, driver);
    await manager.connect('erin', t, driver);
    await manager.shutdown();

    expect(await driver.list()).toHaveLength(0);
    expect(driver.destroyedIds).toHaveLength(2);
  });

  it('dedupes concurrent connect() calls for the same brand-new user into a single provision', async () => {
    const driver = new FakeDriver();
    const manager = new SessionManager({ janitorIntervalMs: 1000 });
    manager.start();
    const t = template();

    const [a, b] = await Promise.all([manager.connect('frank', t, driver), manager.connect('frank', t, driver)]);

    expect(a.id).toBe(b.id);
    expect((await driver.list()).filter((sb) => sb.templateName === 'dev')).toHaveLength(1);
    manager.stop();
  });

  it('a reconnect racing an in-flight eviction gets a fresh sandbox, not the one being destroyed', async () => {
    const driver = new FakeDriver();
    let releaseDestroy!: () => void;
    const destroyGate = new Promise<void>((resolve) => (releaseDestroy = resolve));
    const originalDestroy = driver.destroy.bind(driver);
    driver.destroy = async (sandbox) => {
      await destroyGate;
      await originalDestroy(sandbox);
    };

    const manager = new SessionManager({ janitorIntervalMs: 1000 });
    manager.start();
    const t = template({ reconnectGraceSeconds: 5 });

    const first = await manager.connect('grace', t, driver);
    manager.disconnect('grace');
    await vi.advanceTimersByTimeAsync(6000); // triggers sweep(), which is now paused inside destroy()

    // reconnect while the janitor's destroy() for `first` is still in flight
    const second = await manager.connect('grace', t, driver);
    expect(second.id).not.toBe(first.id); // must be a fresh sandbox, not the one being torn down

    releaseDestroy();
    await vi.advanceTimersByTimeAsync(0);

    expect(driver.destroyedIds).toContain(first.id);
    expect(driver.destroyedIds).not.toContain(second.id);
    manager.stop();
  });

  it('one destroy() throwing during a sweep does not block eviction of other sandboxes or crash', async () => {
    const driver = new FakeDriver();
    const originalDestroy = driver.destroy.bind(driver);
    driver.destroy = async (sandbox) => {
      if (sandbox.templateName === 'dev' && sandbox.id.startsWith('flaky')) {
        throw new Error('boom');
      }
      await originalDestroy(sandbox);
    };
    const errors: string[] = [];
    const manager = new SessionManager({
      janitorIntervalMs: 1000,
      onEvictError: (err) => errors.push(err.message),
    });
    manager.start();
    const t = template({ reconnectGraceSeconds: 1 });

    await manager.connect('flaky-user', t, driver);
    await manager.connect('healthy-user', t, driver);
    manager.disconnect('flaky-user');
    manager.disconnect('healthy-user');
    await vi.advanceTimersByTimeAsync(2000);

    expect(errors).toEqual(['boom']);
    expect(driver.destroyedIds.some((id) => !id.startsWith('flaky'))).toBe(true);
    manager.stop();
  });

  it('classifies simultaneous idle-grace and TTL expiry deterministically as evicted-idle', async () => {
    const driver = new FakeDriver();
    const events: string[] = [];
    const manager = new SessionManager({
      janitorIntervalMs: 1000,
      onEvict: (e) => events.push(e.type),
    });
    manager.start();
    const t = template({ maxTtlSeconds: 5, reconnectGraceSeconds: 5 });

    await manager.connect('hank', t, driver);
    manager.disconnect('hank');
    await vi.advanceTimersByTimeAsync(6000); // both grace and ttl have now elapsed

    expect(events).toEqual(['evicted-idle']);
    manager.stop();
  });
});
