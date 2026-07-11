# Demo output

Real output from running `./examples/demo.sh` on this dev machine (macOS
arm64, no Docker) after `npm install && npm run build`. Nothing here is
edited or fabricated — it's a straight capture.

```
$ ./examples/demo.sh
--- starting ssh-ephemeral (insecure-demo mode, LocalProcessDriver, port 2222) ---
--- connecting: ssh -p 2222 demo@localhost 'echo $SSH_EPHEMERAL_SESSION && whoami' ---
Warning: Permanently added '[localhost]:2222' (ED25519) to the list of known hosts.
demo-1783759578853-wdui15
elenatsvirova
--- disconnected — waiting past the reconnect grace period (3s) and the janitor's 10s sweep interval ---
--- server log line proving the sandbox was destroyed ---
[janitor] evicted-idle sandbox=demo-1783759578853-wdui15 user=demo
--- full server log ---
ssh-ephemeral listening on port 2222
[WARNING] insecure-demo mode: accepting connection from "demo" without checking credentials — never enable this in production
[janitor] evicted-idle sandbox=demo-1783759578853-wdui15 user=demo
```

What happened, line by line:

1. `demo.sh` writes a throwaway YAML config (`insecureDemo: true`, `driver:
   local`, `reconnectGraceSeconds: 3`) and starts `node dist/cli.js` against
   it on port 2222.
2. The system `ssh` client connects. Because `insecureDemo: true`, the server
   accepts the connection without checking any key (see README `## Security`
   — never do this in production).
3. `echo $SSH_EPHEMERAL_SESSION && whoami` runs *inside the freshly
   provisioned sandbox* — `demo-1783759578853-wdui15` is the sandbox ID
   (also exported as an env var in the sandbox), and `elenatsvirova` is
   whatever OS user the `LocalProcessDriver`'s `sh` child process runs as on
   this machine (with the Docker driver this would instead be whatever user
   the container image defines).
4. `ssh` exits, closing the channel. The sandbox isn't destroyed yet — it
   sits in its `reconnectGraceSeconds` grace window in case the same user
   reconnects.
5. Once the grace window (3s) and the janitor's sweep interval (10s by
   default) have both passed, the janitor destroys the sandbox and logs
   `[janitor] evicted-idle sandbox=... user=demo` — the line the script
   greps for as proof.

Deviation from a literal reading of the brief: instead of calling
`driver.list()` from *outside* the server process (which owns the driver
instance and isn't reachable that way once the server is a separate `node`
process), the script greps the server's own log for the janitor's eviction
line — functionally the same proof (the sandbox is gone), captured the way
the process boundary actually allows.
