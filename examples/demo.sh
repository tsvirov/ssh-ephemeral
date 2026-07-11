#!/usr/bin/env bash
# Runs a real ssh-ephemeral server in insecure-demo mode (no Docker required)
# and connects to it with the system `ssh` client. See README.md "Try it in
# 60 seconds" and examples/README.md for the real captured output of this
# script.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f dist/cli.js ]; then
  echo "--- dist/cli.js missing, building first (npm run build) ---"
  npm run build
fi

PORT=2222
WORK_DIR="$(mktemp -d -t ssh-ephemeral-demo-XXXXXX)"
CONFIG="$WORK_DIR/config.yaml"
LOG="$WORK_DIR/server.log"

cat > "$CONFIG" <<YAML
listen:
  port: $PORT
  hostKeyPath: $WORK_DIR/host_key
insecureDemo: true
templates:
  dev:
    driver: local
    maxTtlSeconds: 3600
    reconnectGraceSeconds: 3
users: []
YAML

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

node dist/cli.js "$CONFIG" > "$LOG" 2>&1 &
SERVER_PID=$!

echo "--- starting ssh-ephemeral (insecure-demo mode, LocalProcessDriver, port $PORT) ---"
for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    exec 3<&- 3>&-
    break
  fi
  sleep 0.1
done

ssh_run() {
  ssh -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes \
    demo@localhost 'echo $SSH_EPHEMERAL_SESSION && whoami'
}

echo "--- connect #1: ssh -p $PORT demo@localhost 'echo \$SSH_EPHEMERAL_SESSION && whoami' ---"
FIRST=$(ssh_run)
echo "$FIRST"
FIRST_ID=$(echo "$FIRST" | head -1)

echo "--- disconnected, reconnecting immediately (well within the 3s grace window) ---"
SECOND=$(ssh_run)
echo "$SECOND"
SECOND_ID=$(echo "$SECOND" | head -1)

if [ "$FIRST_ID" = "$SECOND_ID" ]; then
  echo "--- same sandbox id ($FIRST_ID) — reconnect-within-grace reuse confirmed ---"
else
  echo "--- UNEXPECTED: sandbox id changed on immediate reconnect ($FIRST_ID -> $SECOND_ID) ---"
fi

echo "--- disconnected — waiting past the reconnect grace period (3s) and the janitor's 10s sweep interval ---"
sleep 11

echo "--- server log line proving the sandbox was destroyed ---"
grep '\[janitor\] evicted-idle' "$LOG" || echo "(no eviction line found — see full log below)"

echo "--- connect #3, after grace+janitor destroyed the previous sandbox ---"
THIRD=$(ssh_run)
echo "$THIRD"
THIRD_ID=$(echo "$THIRD" | head -1)

if [ "$THIRD_ID" != "$FIRST_ID" ]; then
  echo "--- different sandbox id ($THIRD_ID) — fresh-sandbox-every-time confirmed ---"
else
  echo "--- UNEXPECTED: sandbox id repeated after destroy ---"
fi

echo "--- full server log ---"
cat "$LOG"
