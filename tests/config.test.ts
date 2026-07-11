import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('applies defaults for listen, template ttl/grace, and insecureDemo', () => {
    const cfg = parseConfig({
      templates: { dev: {} },
      users: [{ name: 'alice', keys: ['ssh-ed25519 AAAA'], template: 'dev' }],
    });

    expect(cfg.listen.port).toBe(2222);
    expect(cfg.listen.hostKeyPath.endsWith('/.ssh-ephemeral/host_key')).toBe(true);
    expect(cfg.insecureDemo).toBe(false);
    expect(cfg.templates.dev.driver).toBe('local');
    expect(cfg.templates.dev.maxTtlSeconds).toBe(3600);
    expect(cfg.templates.dev.reconnectGraceSeconds).toBe(60);
  });

  it('expands a leading ~ in hostKeyPath', () => {
    const cfg = parseConfig({ listen: { hostKeyPath: '~/custom/host_key' } });
    expect(cfg.listen.hostKeyPath).not.toContain('~');
    expect(cfg.listen.hostKeyPath.endsWith('/custom/host_key')).toBe(true);
  });

  it('parses explicit template and user fields', () => {
    const cfg = parseConfig({
      listen: { port: 3333, hostKeyPath: '/tmp/hk' },
      templates: {
        dev: { driver: 'docker', image: 'node:22-slim', memoryMb: 256, cpus: 2, maxTtlSeconds: 100, reconnectGraceSeconds: 5 },
      },
      users: [{ name: 'bob', keys: ['ssh-ed25519 AAAA', 'ssh-ed25519 BBBB'], template: 'dev' }],
      insecureDemo: true,
    });

    expect(cfg.listen.port).toBe(3333);
    expect(cfg.templates.dev).toEqual({
      name: 'dev',
      driver: 'docker',
      image: 'node:22-slim',
      memoryMb: 256,
      cpus: 2,
      maxTtlSeconds: 100,
      reconnectGraceSeconds: 5,
    });
    expect(cfg.users[0]).toEqual({ name: 'bob', keys: ['ssh-ed25519 AAAA', 'ssh-ed25519 BBBB'], template: 'dev' });
    expect(cfg.insecureDemo).toBe(true);
  });

  it('rejects a non-object top level config', () => {
    expect(() => parseConfig('not-an-object')).toThrow();
    expect(() => parseConfig(null)).toThrow();
  });

  it('defaults an unrecognized driver value to local rather than silently accepting garbage', () => {
    const cfg = parseConfig({ templates: { dev: { driver: 'nonsense' } } });
    expect(cfg.templates.dev.driver).toBe('local');
  });
});
