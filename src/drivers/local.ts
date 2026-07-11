import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxDriver, Sandbox, Template, PtyInfo } from '../driver.js';

const MARKER_FILE = '.ssh-ephemeral-marker';

interface Entry {
  sandbox: Sandbox;
  tmpDir: string;
  activeProc?: ChildProcessWithoutNullStreams;
}

/**
 * Runs each sandbox as a plain `sh` child process in a fresh tmp directory —
 * no container, no node-pty (native builds are a CI pain across OSes; plain
 * pipes are enough for non-interactive echo-style tests and the demo). This
 * is the ONLY driver exercised by unit tests and examples/demo.sh, since this
 * dev machine has no Docker.
 */
export class LocalProcessDriver implements SandboxDriver {
  readonly name = 'local' as const;
  private entries = new Map<string, Entry>();

  async provision(template: Template, sessionId: string): Promise<Sandbox> {
    const tmpDir = await mkdtemp(join(tmpdir(), `ssh-ephemeral-${sessionId}-`));
    await writeFile(join(tmpDir, MARKER_FILE), `${sessionId}\n${Date.now()}\n`, 'utf8');
    const sandbox: Sandbox = {
      id: sessionId,
      templateName: template.name,
      createdAt: Date.now(),
      driverName: 'local',
      meta: { tmpDir },
    };
    this.entries.set(sessionId, { sandbox, tmpDir });
    return sandbox;
  }

  async attach(sandbox: Sandbox, _opts: { pty?: PtyInfo }): Promise<Duplex> {
    const entry = this.entries.get(sandbox.id);
    if (!entry) throw new Error(`unknown sandbox: ${sandbox.id}`);

    const child = spawn('sh', [], {
      cwd: entry.tmpDir,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SSH_EPHEMERAL_SESSION: sandbox.id,
        HOME: entry.tmpDir,
      },
      stdio: 'pipe',
    });
    entry.activeProc = child;

    const duplex = new Duplex({
      write(chunk, _enc, cb) {
        child.stdin.write(chunk, cb);
      },
      read() {
        // pushes happen from the child's stdout/stderr listeners below
      },
      final(cb) {
        child.stdin.end();
        cb();
      },
      destroy(err, cb) {
        if (!child.killed) child.kill();
        cb(err);
      },
    });

    child.stdout.on('data', (chunk: Buffer) => duplex.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => duplex.push(chunk));
    child.on('exit', () => {
      duplex.push(null);
      if (entry.activeProc === child) entry.activeProc = undefined;
    });

    return duplex;
  }

  // No real pty backs this driver (see README §Limitations) — resize is a
  // documented no-op rather than a silent lie about terminal geometry.
  async resize(_sandbox: Sandbox, _cols: number, _rows: number): Promise<void> {}

  async destroy(sandbox: Sandbox): Promise<void> {
    const entry = this.entries.get(sandbox.id);
    if (!entry) return;
    if (entry.activeProc && !entry.activeProc.killed) entry.activeProc.kill();
    await rm(entry.tmpDir, { recursive: true, force: true });
    this.entries.delete(sandbox.id);
  }

  async list(): Promise<Sandbox[]> {
    return [...this.entries.values()].map((e) => e.sandbox);
  }
}
