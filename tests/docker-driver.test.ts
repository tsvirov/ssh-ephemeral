import { describe, expect, it } from 'vitest';
import { DockerDriver } from '../src/drivers/docker.js';
import type { Sandbox, Template } from '../src/driver.js';

// Only runs in the CI-only docker-integration job (ubuntu-latest, Docker
// preinstalled). Never runs on this dev machine — there's no Docker here.
const RUN_DOCKER = process.env.SSH_EPHEMERAL_DOCKER === '1';

const template: Template = {
  name: 'dev',
  driver: 'docker',
  image: 'alpine:3.20',
  memoryMb: 128,
  cpus: 1,
  maxTtlSeconds: 3600,
  reconnectGraceSeconds: 60,
};

function collect(duplex: NodeJS.ReadWriteStream, ms = 1500): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    duplex.on('data', (chunk: Buffer) => (out += chunk.toString()));
    setTimeout(() => resolve(out), ms);
  });
}

describe.runIf(RUN_DOCKER)('DockerDriver (CI-only, SSH_EPHEMERAL_DOCKER=1)', () => {
  it(
    'provisions a real container and runs a shell command inside it',
    async () => {
      const driver = new DockerDriver();
      const sb = await driver.provision(template, 'docker-sess-a');
      try {
        const duplex = await driver.attach(sb, {});
        duplex.write('echo hi\n');
        const output = await collect(duplex);
        expect(output).toContain('hi');
        duplex.end();
      } finally {
        await driver.destroy(sb);
      }
    },
    30000,
  );

  it(
    'destroy removes the container from list()',
    async () => {
      const driver = new DockerDriver();
      const sb = await driver.provision(template, 'docker-sess-b');
      await driver.destroy(sb);
      expect((await driver.list()).find((s: Sandbox) => s.id === sb.id)).toBeUndefined();
    },
    30000,
  );

  it(
    'isolates two containers from the same template into separate sandboxes',
    async () => {
      const driver = new DockerDriver();
      const a = await driver.provision(template, 'docker-sess-c');
      const b = await driver.provision(template, 'docker-sess-d');
      try {
        expect(a.meta.containerId).not.toBe(b.meta.containerId);
        const duplexA = await driver.attach(a, {});
        duplexA.write('echo topsecretvalue > /tmp/secret.txt\n');
        await collect(duplexA, 800);
        duplexA.end();

        const duplexB = await driver.attach(b, {});
        duplexB.write('cat /tmp/secret.txt\n');
        const output = await collect(duplexB, 800);
        duplexB.end();
        // The command line itself (echoed back over the tty) legitimately
        // contains "secret" in the filename — only the file's actual
        // content proves (or disproves) cross-container leakage.
        expect(output).not.toContain('topsecretvalue');
      } finally {
        await driver.destroy(a);
        await driver.destroy(b);
      }
    },
    30000,
  );
});
