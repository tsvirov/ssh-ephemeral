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
});
