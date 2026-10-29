# CLAUDE.md

Twitch/Kick → Discord notification service on a single Cloudflare Worker with D1. Plain ES modules, no bundler or framework, no runtime dependencies. See `README.md` for behavior, limits, and source layout.

## Environment

- Development runs in Claude Code cloud sessions. The `SessionStart` hook installs dependencies; if `node_modules` is missing, run `npm ci`.
- Cloudflare Workers Builds deploys from GitHub: pushes to `main` migrate D1 and deploy, other branches only run checks. Never run `npm run deploy`, `npm run db:remote`, `wrangler deploy` (without `--dry-run`), `wrangler secret`, or `wrangler login` from a session.
- No Cloudflare credentials or production secrets exist in sessions, and none are needed. Tests mock every external API and use Miniflare with throwaway D1 databases.

## Commands

- `npm run verify`: syntax check, Prettier check, and tests. Run before every commit; Workers Builds runs the same command and blocks the deploy on failure.
- `npm test`: tests only (Node's test runner, ~20 s).
- `npm run format`: apply Prettier.
- `npx wrangler deploy --dry-run`: confirm the Worker bundles.

## Conventions

- Work on a branch and open a pull request; do not push to `main` directly.
- Commit messages are one sentence.
- Comment only when code is genuinely complex.
- Prettier: single quotes, 100-column width, ES5 trailing commas.
- New source files must be added to the `check` script in `package.json`.
- Schema changes go in a new numbered file in `migrations/`. Migrations run before the new Worker is uploaded, so keep them additive and never edit a shipped migration.
- New secrets go in `.dev.vars.example` and the README secrets table; new non-secret config goes in `vars` in `wrangler.jsonc`.
- Keep security properties intact: encrypted webhook URLs, canonical Discord webhook validation, same-origin checks on writes, signature verification on `/hooks/*`. Add a test with any behavior change.
