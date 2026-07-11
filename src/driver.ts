import type { Duplex } from 'node:stream';

export type DriverName = 'local' | 'docker';

export interface Template {
  name: string;
  driver: DriverName;
  image?: string;
  memoryMb?: number;
  cpus?: number;
  maxTtlSeconds: number;
  reconnectGraceSeconds: number;
}

export interface Sandbox {
  id: string;
  templateName: string;
  createdAt: number;
  driverName: DriverName;
  meta: Record<string, unknown>;
}

export interface PtyInfo {
  cols: number;
  rows: number;
}

/**
 * Abstraction over "where a shell actually runs". LocalProcessDriver is the
 * only engine used by tests/demo (no Docker on this dev machine); DockerDriver
 * mirrors the same contract for the CI-only integration job. See README §Security
 * and §Limitations for the guarantees (and non-guarantees) each one provides.
 */
export interface SandboxDriver {
  readonly name: DriverName;
  provision(template: Template, sessionId: string): Promise<Sandbox>;
  attach(sandbox: Sandbox, opts: { pty?: PtyInfo }): Promise<Duplex>;
  resize(sandbox: Sandbox, cols: number, rows: number): Promise<void>;
  destroy(sandbox: Sandbox): Promise<void>;
  list(): Promise<Sandbox[]>;
}
