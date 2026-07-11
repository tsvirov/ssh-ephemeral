import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, utils as sshUtils } from 'ssh2';
import { createServer, type EphemeralServerHandle } from '../src/server.js';
import { LocalProcessDriver } from '../src/drivers/local.js';
import type { EphemeralConfig } from '../src/config.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRsaKeyPair() {
  // ssh2's own utils.generateKeyPairSync('rsa', ...) produces a key that
  // fails signature verification through the real wire protocol in this
  // environment; Node's own PKCS1 RSA keypair round-trips correctly.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const parsed = sshUtils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const publicLine = `${parsed.type} ${parsed.getPublicSSH().toString('base64')}`;
  return { private: privateKey, public: publicLine };
}

function makeKeyPair() {
  // ssh2's generateKeyPairSync occasionally emits a malformed key (observed
  // directly during this project's own development) — retry rather than let
  // that flake a test unrelated to key generation.
  for (let attempt = 0; attempt < 5; attempt++) {
    const kp = sshUtils.generateKeyPairSync('ed25519');
    if (!(sshUtils.parseKey(kp.private) instanceof Error)) return kp;
  }
  throw new Error('failed to generate a valid ed25519 test key after 5 attempts');
}

function baseConfig(hostKeyDir: string, overrides: Partial<EphemeralConfig> = {}): EphemeralConfig {
  return {
    listen: { port: 0, hostKeyPath: join(hostKeyDir, 'host_key') },
    templates: { dev: { name: 'dev', driver: 'local', maxTtlSeconds: 3600, reconnectGraceSeconds: 1 } },
    users: [],
    insecureDemo: false,
    ...overrides,
  };
}

function listenEphemeral(handle: EphemeralServerHandle): Promise<number> {
  return new Promise((resolve) => {
    handle.server.listen(0, '127.0.0.1', () => {
      const addr = handle.server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

function connectClient(port: number, username: string, privateKey: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client));
    client.on('error', reject);
    client.connect({ host: '127.0.0.1', port, username, privateKey, readyTimeout: 5000 });
  });
}

function shellExec(client: Client, command: string, waitMs = 400): Promise<string> {
  return new Promise((resolve, reject) => {
    client.shell((err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (chunk: Buffer) => (out += chunk.toString()));
      stream.write(`${command}\n`);
      setTimeout(() => {
        stream.end();
        resolve(out);
      }, waitMs);
    });
  });
}

describe('ssh-ephemeral server (integration, LocalProcessDriver only — no Docker on this machine)', () => {
  let hostKeyDir: string;

  beforeEach(() => {
    hostKeyDir = mkdtempSync(join(tmpdir(), 'ssh-ephemeral-hostkey-'));
  });
  afterEach(() => {
    rmSync(hostKeyDir, { recursive: true, force: true });
  });

  it(
    'accepts a publickey connection, runs a shell command, and streams the correct output',
    async () => {
      const { private: privateKey, public: publicKey } = makeKeyPair();
      const config = baseConfig(hostKeyDir, { users: [{ name: 'alice', keys: [publicKey], template: 'dev' }] });
      const handle = createServer({ config, janitorIntervalMs: 100, log: () => {} });
      const port = await listenEphemeral(handle);

      const client = await connectClient(port, 'alice', privateKey);
      const output = await shellExec(client, 'echo hi');
      expect(output).toContain('hi');

      client.end();
      await handle.close();
      handle.server.close();
    },
    10000,
  );

  it(
    'reuses the same sandbox when the same user reconnects within the grace window',
    async () => {
      const { private: privateKey, public: publicKey } = makeKeyPair();
      const config = baseConfig(hostKeyDir, {
        templates: { dev: { name: 'dev', driver: 'local', maxTtlSeconds: 3600, reconnectGraceSeconds: 2 } },
        users: [{ name: 'bob', keys: [publicKey], template: 'dev' }],
      });
      const handle = createServer({ config, janitorIntervalMs: 100, log: () => {} });
      const port = await listenEphemeral(handle);

      const client1 = await connectClient(port, 'bob', privateKey);
      await shellExec(client1, 'echo first');
      const sandboxBefore = handle.manager.getSandbox('bob');
      client1.end();
      await sleep(300); // disconnect registers, well within the 2s grace window

      const client2 = await connectClient(port, 'bob', privateKey);
      await shellExec(client2, 'echo second');
      const sandboxAfter = handle.manager.getSandbox('bob');

      expect(sandboxAfter?.id).toBe(sandboxBefore?.id);

      client2.end();
      await handle.close();
      handle.server.close();
    },
    10000,
  );

  it(
    'destroys the sandbox once the reconnect grace period elapses (no reconnect)',
    async () => {
      const { private: privateKey, public: publicKey } = makeKeyPair();
      const config = baseConfig(hostKeyDir, {
        templates: { dev: { name: 'dev', driver: 'local', maxTtlSeconds: 3600, reconnectGraceSeconds: 1 } },
        users: [{ name: 'carol', keys: [publicKey], template: 'dev' }],
      });
      const driver = new LocalProcessDriver();
      const handle = createServer({ config, drivers: { local: driver }, janitorIntervalMs: 100, log: () => {} });
      const port = await listenEphemeral(handle);

      const client = await connectClient(port, 'carol', privateKey);
      await shellExec(client, 'echo hi');
      client.end();

      await sleep(2000); // past the 1s grace window plus a few janitor ticks

      expect(await driver.list()).toHaveLength(0);

      await handle.close();
      handle.server.close();
    },
    10000,
  );

  it(
    'isolates two different users on the same template into separate sandboxes',
    async () => {
      const alice = makeKeyPair();
      const bob = makeKeyPair();
      const config = baseConfig(hostKeyDir, {
        users: [
          { name: 'alice2', keys: [alice.public], template: 'dev' },
          { name: 'bob2', keys: [bob.public], template: 'dev' },
        ],
      });
      const handle = createServer({ config, janitorIntervalMs: 100, log: () => {} });
      const port = await listenEphemeral(handle);

      const clientA = await connectClient(port, 'alice2', alice.private);
      await shellExec(clientA, 'echo alice-secret > secret.txt');
      const sandboxA = handle.manager.getSandbox('alice2');

      const clientB = await connectClient(port, 'bob2', bob.private);
      const catOutput = await shellExec(clientB, 'cat secret.txt');
      const sandboxB = handle.manager.getSandbox('bob2');

      expect(sandboxA?.id).not.toBe(sandboxB?.id);
      expect(catOutput).not.toContain('alice-secret');

      clientA.end();
      clientB.end();
      await handle.close();
      handle.server.close();
    },
    10000,
  );

  it(
    'rejects a connection presenting an unauthorized key',
    async () => {
      const { public: publicKey } = makeKeyPair();
      const stranger = makeKeyPair();
      const config = baseConfig(hostKeyDir, { users: [{ name: 'dave', keys: [publicKey], template: 'dev' }] });
      const handle = createServer({ config, janitorIntervalMs: 100, log: () => {} });
      const port = await listenEphemeral(handle);

      await expect(connectClient(port, 'dave', stranger.private)).rejects.toThrow();

      await handle.close();
      handle.server.close();
    },
    10000,
  );

  it(
    'accepts a modern RSA key (rsa-sha2-512 signature algo, not the legacy ssh-rsa/SHA-1 one)',
    async () => {
      const { private: privateKey, public: publicKey } = makeRsaKeyPair();
      const config = baseConfig(hostKeyDir, { users: [{ name: 'ivan', keys: [publicKey], template: 'dev' }] });
      const handle = createServer({ config, janitorIntervalMs: 100, log: () => {} });
      const port = await listenEphemeral(handle);

      const client = await connectClient(port, 'ivan', privateKey);
      const output = await shellExec(client, 'echo hi');
      expect(output).toContain('hi');

      client.end();
      await handle.close();
      handle.server.close();
    },
    10000,
  );

  it(
    'rejects an unknown username with the same auth-methods-left shape as a known user with a wrong key (no username enumeration)',
    async () => {
      const { public: publicKey } = makeKeyPair();
      const stranger = makeKeyPair();
      const config = baseConfig(hostKeyDir, { users: [{ name: 'judy', keys: [publicKey], template: 'dev' }] });
      const handle = createServer({ config, janitorIntervalMs: 100, log: () => {} });
      const port = await listenEphemeral(handle);

      await expect(connectClient(port, 'nobody-configured', stranger.private)).rejects.toThrow(
        /All configured authentication methods failed/,
      );
      await expect(connectClient(port, 'judy', stranger.private)).rejects.toThrow(
        /All configured authentication methods failed/,
      );

      await handle.close();
      handle.server.close();
    },
    10000,
  );

  it(
    'destroys all live sandboxes on shutdown (the SIGTERM handler path), even mid-session',
    async () => {
      const { private: privateKey, public: publicKey } = makeKeyPair();
      const config = baseConfig(hostKeyDir, { users: [{ name: 'erin', keys: [publicKey], template: 'dev' }] });
      const driver = new LocalProcessDriver();
      const handle = createServer({ config, drivers: { local: driver }, janitorIntervalMs: 100, log: () => {} });
      const port = await listenEphemeral(handle);

      const client = await connectClient(port, 'erin', privateKey);
      await new Promise<void>((resolve, reject) => {
        client.shell((err, stream) => {
          if (err) return reject(err);
          stream.write('sleep 30\n');
          resolve();
        });
      });
      await sleep(300); // session is actively provisioned, process running

      expect(await driver.list()).toHaveLength(1);
      await handle.close(); // exactly what cli.ts calls from the SIGTERM/SIGINT handler
      expect(await driver.list()).toHaveLength(0);

      client.end();
      handle.server.close();
    },
    10000,
  );
});
