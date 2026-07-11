import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalProcessDriver } from '../src/drivers/local.js';
import type { Sandbox, Template } from '../src/driver.js';

const template: Template = { name: 'dev', driver: 'local', maxTtlSeconds: 3600, reconnectGraceSeconds: 60 };

function collect(duplex: NodeJS.ReadWriteStream, ms = 400): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    duplex.on('data', (chunk: Buffer) => (out += chunk.toString()));
    setTimeout(() => resolve(out), ms);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('LocalProcessDriver', () => {
  const driver = new LocalProcessDriver();
  const provisioned: Sandbox[] = [];

  afterEach(async () => {
    for (const sb of provisioned.splice(0)) {
      await driver.destroy(sb);
    }
  });

  it('provisions a sandbox with a fresh tmp dir and marker file', async () => {
    const sb = await driver.provision(template, 'sess-a');
    provisioned.push(sb);
    const tmpDir = sb.meta.tmpDir as string;
    expect(existsSync(tmpDir)).toBe(true);
    expect(existsSync(join(tmpDir, '.ssh-ephemeral-marker'))).toBe(true);
  });

  it('runs shell commands through attach and streams back the output', async () => {
    const sb = await driver.provision(template, 'sess-b');
    provisioned.push(sb);
    const duplex = await driver.attach(sb, {});
    duplex.write('echo hi\n');
    const output = await collect(duplex);
    expect(output).toContain('hi');
    duplex.destroy();
  });

  it('isolates two sandboxes in separate tmp dirs — one cannot see the other', async () => {
    const a = await driver.provision(template, 'sess-c');
    const b = await driver.provision(template, 'sess-d');
    provisioned.push(a, b);
    expect(a.meta.tmpDir).not.toBe(b.meta.tmpDir);

    const duplexA = await driver.attach(a, {});
    duplexA.write('echo secret > secret.txt\n');
    await collect(duplexA, 300);
    duplexA.destroy();

    expect(existsSync(join(a.meta.tmpDir as string, 'secret.txt'))).toBe(true);
    expect(existsSync(join(b.meta.tmpDir as string, 'secret.txt'))).toBe(false);
  });

  it('destroy removes the tmp dir and drops the sandbox from list()', async () => {
    const sb = await driver.provision(template, 'sess-e');
    await driver.destroy(sb);
    expect(existsSync(sb.meta.tmpDir as string)).toBe(false);
    expect((await driver.list()).find((s) => s.id === sb.id)).toBeUndefined();
  });

  it('destroy kills descendant processes started inside the sandbox, not just the shell itself', async () => {
    const sb = await driver.provision(template, 'sess-f');
    provisioned.push(sb);
    const duplex = await driver.attach(sb, {});
    duplex.write('sleep 20 & echo $! > child.pid\n');
    await collect(duplex, 300);

    const pidText = readFileSync(join(sb.meta.tmpDir as string, 'child.pid'), 'utf8').trim();
    const childPid = Number(pidText);
    expect(childPid).toBeGreaterThan(0);
    expect(isAlive(childPid)).toBe(true);

    await driver.destroy(sb);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(isAlive(childPid)).toBe(false);
  });
});
