import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
// ssh2 is a CJS module; named imports break in the bundled ESM output
// (Node can't statically detect its named exports there), so import the
// default and destructure at runtime instead.
import ssh2 from 'ssh2';
import type { Connection, AuthContext, Server as SshServer } from 'ssh2';

const { Server, utils: sshUtils } = ssh2;
import type { SandboxDriver, PtyInfo } from './driver.js';
import type { EphemeralConfig, UserConfig } from './config.js';
import { SessionManager } from './session-manager.js';
import { LocalProcessDriver } from './drivers/local.js';
import { DockerDriver } from './drivers/docker.js';

function ensureHostKey(path: string): Buffer {
  if (existsSync(path)) return readFileSync(path);
  mkdirSync(dirname(path), { recursive: true });
  // ssh2's parseKey only understands its own OpenSSH-format keys for ed25519
  // (Node's PKCS8 PEM output isn't one of them), so generate via ssh2 itself.
  const { private: privateKey } = sshUtils.generateKeyPairSync('ed25519');
  writeFileSync(path, privateKey, { mode: 0o600 });
  return Buffer.from(privateKey);
}

function keyMatches(authorizedKeyLine: string, ctx: AuthContext & { method: 'publickey' }): boolean {
  const parsed = sshUtils.parseKey(authorizedKeyLine);
  if (!parsed || parsed instanceof Error) return false;
  if (ctx.key.algo !== parsed.type) return false;
  const keyBuf = parsed.getPublicSSH();
  if (!keyBuf || Buffer.compare(ctx.key.data, keyBuf) !== 0) return false;
  if (ctx.signature) {
    return parsed.verify(ctx.blob as Buffer, ctx.signature) === true;
  }
  // no signature yet: client is only probing whether this key would be accepted
  return true;
}

export interface EphemeralServerOptions {
  config: EphemeralConfig;
  drivers?: Partial<Record<'local' | 'docker', SandboxDriver>>;
  janitorIntervalMs?: number;
  clock?: () => number;
  log?: (msg: string) => void;
}

export interface EphemeralServerHandle {
  server: SshServer;
  manager: SessionManager;
  drivers: Record<'local' | 'docker', SandboxDriver>;
  /** Destroys every live sandbox — call this from the SIGTERM/SIGINT handler. */
  close: () => Promise<void>;
}

export function createServer(opts: EphemeralServerOptions): EphemeralServerHandle {
  const log = opts.log ?? ((m: string) => console.log(m));
  const drivers: Record<'local' | 'docker', SandboxDriver> = {
    local: opts.drivers?.local ?? new LocalProcessDriver(),
    docker: opts.drivers?.docker ?? new DockerDriver(),
  };

  const manager = new SessionManager({
    janitorIntervalMs: opts.janitorIntervalMs,
    clock: opts.clock,
    onEvict: (e) => log(`[janitor] ${e.type} sandbox=${e.sandboxId} user=${e.username}`),
  });
  manager.start();

  const hostKey = ensureHostKey(opts.config.listen.hostKeyPath);
  const usersByName = new Map<string, UserConfig>(opts.config.users.map((u) => [u.name, u]));
  const firstTemplateName = Object.keys(opts.config.templates)[0];

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    let authedUser: UserConfig | undefined;

    client.on('authentication', (ctx) => {
      if (opts.config.insecureDemo) {
        log(
          `[WARNING] insecure-demo mode: accepting connection from "${ctx.username}" without checking credentials — never enable this in production`,
        );
        authedUser = usersByName.get(ctx.username) ?? {
          name: ctx.username,
          keys: [],
          template: firstTemplateName,
        };
        ctx.accept();
        return;
      }

      const user = usersByName.get(ctx.username);
      if (!user) {
        ctx.reject();
        return;
      }
      if (ctx.method !== 'publickey') {
        ctx.reject(['publickey']);
        return;
      }
      const ok = user.keys.some((k) => keyMatches(k, ctx as AuthContext & { method: 'publickey' }));
      if (!ok) {
        ctx.reject(['publickey']);
        return;
      }
      authedUser = user;
      ctx.accept();
    });

    client.on('ready', () => {
      const user = authedUser;
      if (!user) {
        client.end();
        return;
      }
      const template = opts.config.templates[user.template];
      if (!template) {
        log(`[error] user "${user.name}" references unknown template "${user.template}"`);
        client.end();
        return;
      }
      const driver = drivers[template.driver];

      client.on('session', (accept) => {
        const session = accept();
        let ptyInfo: PtyInfo | undefined;

        session.on('pty', (accept2, _reject2, info) => {
          ptyInfo = { cols: info.cols, rows: info.rows };
          accept2?.();
        });

        session.on('window-change', (accept2, _reject2, info) => {
          const sandbox = manager.getSandbox(user.name);
          if (sandbox) driver.resize(sandbox, info.cols, info.rows).catch(() => {});
          accept2?.();
        });

        const attachShell = async (channel: import('ssh2').ServerChannel, initialCommand?: string) => {
          try {
            const sandbox = await manager.connect(user.name, template, driver);
            const duplex = await driver.attach(sandbox, { pty: ptyInfo });
            channel.pipe(duplex, { end: false });
            // end:false — otherwise Node's pipe() auto-ends the channel the instant
            // the shell's output stream ends, racing ahead of channel.exit() below
            // and sending EOF before the exit-status request goes out.
            duplex.pipe(channel, { end: false });
            if (initialCommand) duplex.write(`${initialCommand}\n`);
            // exec channels (`ssh host 'cmd'`) close their write side as soon as the
            // client has nothing more to send — that's our cue to close the shell's
            // stdin too, so the underlying `sh` process exits after running the command.
            channel.on('end', () => duplex.end());
            duplex.on('end', () => {
              channel.exit(0);
              channel.end();
            });
            channel.on('close', () => {
              duplex.destroy();
              manager.disconnect(user.name);
            });
            duplex.on('error', () => channel.close());
          } catch (err) {
            log(`[error] session setup failed for "${user.name}": ${(err as Error).message}`);
            channel.close();
          }
        };

        session.on('shell', (accept2) => {
          void attachShell(accept2());
        });

        session.on('exec', (accept2, _reject2, info) => {
          // Append "exit" so the underlying shell terminates itself right after
          // running the command — exec channels must not depend on the client
          // ever sending a channel EOF (many ssh clients don't, and would hang
          // forever waiting for a close that never comes).
          void attachShell(accept2(), `${info.command}\nexit`);
        });
      });
    });

    client.on('close', () => {
      if (authedUser) manager.disconnect(authedUser.name);
    });

    client.on('error', (err) => {
      log(`[error] client connection error: ${err.message}`);
    });
  });

  return {
    server,
    manager,
    drivers,
    close: () => manager.shutdown(),
  };
}
