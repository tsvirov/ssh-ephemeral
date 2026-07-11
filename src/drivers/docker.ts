import Docker from 'dockerode';
import type { Duplex } from 'node:stream';
import type { SandboxDriver, Sandbox, Template, PtyInfo } from '../driver.js';

interface Entry {
  sandbox: Sandbox;
  containerId: string;
  exec?: Docker.Exec;
}

/**
 * Real container-backed driver used only by the CI-only Docker integration
 * job (SSH_EPHEMERAL_DOCKER=1, ubuntu-latest). Not runnable/tested on this
 * dev machine — there is no Docker daemon here (see README §Limitations).
 */
export class DockerDriver implements SandboxDriver {
  readonly name = 'docker' as const;
  private docker: Docker;
  private entries = new Map<string, Entry>();

  constructor(dockerOpts?: Docker.DockerOptions) {
    this.docker = new Docker(dockerOpts);
  }

  async provision(template: Template, sessionId: string): Promise<Sandbox> {
    if (!template.image) {
      throw new Error(`template "${template.name}" needs "image" for the docker driver`);
    }
    const container = await this.docker.createContainer({
      Image: template.image,
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      Labels: { 'ssh-ephemeral-session': sessionId },
      Cmd: ['sh'],
      HostConfig: {
        Memory: (template.memoryMb ?? 512) * 1024 * 1024,
        NanoCpus: (template.cpus ?? 1) * 1e9,
        AutoRemove: false,
      },
    });
    await container.start();
    const sandbox: Sandbox = {
      id: sessionId,
      templateName: template.name,
      createdAt: Date.now(),
      driverName: 'docker',
      meta: { containerId: container.id },
    };
    this.entries.set(sessionId, { sandbox, containerId: container.id });
    return sandbox;
  }

  async attach(sandbox: Sandbox, opts: { pty?: PtyInfo }): Promise<Duplex> {
    const entry = this.entries.get(sandbox.id);
    if (!entry) throw new Error(`unknown sandbox: ${sandbox.id}`);
    const container = this.docker.getContainer(entry.containerId);
    const exec = await container.exec({
      Cmd: ['sh'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    entry.exec = exec;
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    if (opts.pty) {
      await exec.resize({ w: opts.pty.cols, h: opts.pty.rows }).catch(() => {});
    }
    return stream as unknown as Duplex;
  }

  async resize(sandbox: Sandbox, cols: number, rows: number): Promise<void> {
    const entry = this.entries.get(sandbox.id);
    if (!entry?.exec) return;
    await entry.exec.resize({ w: cols, h: rows }).catch(() => {});
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    const entry = this.entries.get(sandbox.id);
    if (!entry) return;
    const container = this.docker.getContainer(entry.containerId);
    await container.kill().catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    this.entries.delete(sandbox.id);
  }

  async list(): Promise<Sandbox[]> {
    return [...this.entries.values()].map((e) => e.sandbox);
  }
}
