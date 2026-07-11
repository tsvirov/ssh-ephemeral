# Contributing

Thanks for considering a contribution to ssh-ephemeral.

## Setup

```bash
npm install
npm run build
npm test
npm run lint
```

## Before opening a PR

- `npm test` and `npm run lint` must pass. CI runs both on Node 20 and 22.
- If you touch `src/drivers/docker.ts`, note that it isn't runnable on every
  dev machine — it's covered by a separate CI job gated on
  `SSH_EPHEMERAL_DOCKER=1` (`ubuntu-latest`, which has Docker preinstalled).
  You won't be able to run it locally without a Docker daemon; that's fine,
  CI will.
- Keep `README.md` in sync with any config/CLI/behavior change — the config
  example there is meant to match `src/config.ts` field-for-field.
- Never commit generated host keys, private keys, or anything matching the
  patterns in `.gitignore`.

## Reporting bugs / requesting features

Use the issue templates in `.github/ISSUE_TEMPLATE.md`.
