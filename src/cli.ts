#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createServer } from './server.js';

const configPath = process.argv[2] ?? process.env.SSH_EPHEMERAL_CONFIG ?? './ssh-ephemeral.yaml';
const config = loadConfig(configPath);
const { server, close } = createServer({ config });

server.listen(config.listen.port, '0.0.0.0', () => {
  console.log(`ssh-ephemeral listening on port ${config.listen.port}`);
});

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${sig}] shutting down, destroying all live sandboxes...`);
    void close().then(() => {
      server.close(() => process.exit(0));
    });
  });
}
