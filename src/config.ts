import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { Template } from './driver.js';

export interface UserConfig {
  name: string;
  keys: string[];
  template: string;
}

export interface ListenConfig {
  port: number;
  hostKeyPath: string;
}

export interface EphemeralConfig {
  listen: ListenConfig;
  templates: Record<string, Template>;
  users: UserConfig[];
  insecureDemo: boolean;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

interface RawConfig {
  listen?: { port?: number; hostKeyPath?: string };
  templates?: Record<
    string,
    { driver?: string; image?: string; memoryMb?: number; cpus?: number; maxTtlSeconds?: number; reconnectGraceSeconds?: number }
  >;
  users?: { name: string; keys?: string[]; template: string }[];
  insecureDemo?: boolean;
}

export function parseConfig(raw: unknown): EphemeralConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid config: expected a YAML mapping at the top level');
  }
  const cfg = raw as RawConfig;

  const listen: ListenConfig = {
    port: cfg.listen?.port ?? 2222,
    hostKeyPath: expandHome(cfg.listen?.hostKeyPath ?? '~/.ssh-ephemeral/host_key'),
  };

  const templates: Record<string, Template> = {};
  for (const [name, t] of Object.entries(cfg.templates ?? {})) {
    templates[name] = {
      name,
      driver: t.driver === 'docker' ? 'docker' : 'local',
      image: t.image,
      memoryMb: t.memoryMb,
      cpus: t.cpus,
      maxTtlSeconds: t.maxTtlSeconds ?? 3600,
      reconnectGraceSeconds: t.reconnectGraceSeconds ?? 60,
    };
  }

  const users: UserConfig[] = (cfg.users ?? []).map((u) => ({
    name: u.name,
    keys: u.keys ?? [],
    template: u.template,
  }));

  return { listen, templates, users, insecureDemo: cfg.insecureDemo === true };
}

export function loadConfig(path: string): EphemeralConfig {
  const raw = load(readFileSync(path, 'utf8'));
  return parseConfig(raw);
}
