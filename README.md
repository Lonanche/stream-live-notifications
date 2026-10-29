# Stream Live Notifications

A multi-user Twitch/Kick → Discord notification service built for **your Cloudflare account**. A Worker serves the dashboard, receives signed platform webhooks, and runs scheduled reconciliation and Discord delivery retries. Cloudflare D1 stores users, rules, sessions, channel state, and the durable delivery outbox.

Users sign in with Discord, enter any Twitch or Kick channel, paste a Discord channel webhook, and customize the announcement. Each account can add multiple rules, edit messages or destinations, pause/resume, delete, send a test, and inspect delivery history. No streamer OAuth login or Discord bot installation is required. Only the site owner sets up developer applications once.

## Deploy to Cloudflare

Builds and deploys run on [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) from the GitHub repository. Nothing is deployed from a developer machine: every push runs the checks on Cloudflare, and a push to `main` applies pending D1 migrations and deploys the Worker.

Prerequisites: this repository on GitHub, a Cloudflare account with Workers and D1, and developer applications for Discord and whichever streaming platforms you enable. Everything below is done once in the Cloudflare dashboard and the provider consoles; no local tooling is needed.

1. Create the database in **Storage & Databases → D1 → Create** and name it `stream-live-notifications`. Put its ID in `d1_databases[0].database_id` in `wrangler.jsonc`. Set `vars.APP_URL` to the final HTTPS origin, such as `https://stream-live-notifications.YOUR-SUBDOMAIN.workers.dev` or your custom domain. **No trailing slash or path.** Retain the every-minute cron trigger. Commit and push.

2. Connect the repository. For a new installation use **Workers & Pages → Create → Import a repository**; for an existing Worker use **Worker → Settings → Build → Connect**. The Worker name must stay `stream-live-notifications` to match `wrangler.jsonc`. Use these build settings:

   | Setting                              | Value                           |
   | ------------------------------------ | ------------------------------- |
   | Production branch                    | `main`                          |
   | Build command                        | `npm run verify`                |
   | Deploy command                       | `npm run deploy`                |
   | Non-production branch deploy command | `npx wrangler deploy --dry-run` |
   | Root directory                       | `/`                             |

   Workers Builds installs dependencies from `package-lock.json` and uses Node 22 from `.node-version`. `npm run deploy` runs `wrangler d1 migrations apply DB --remote` before `wrangler deploy`, so the build API token needs **D1: Edit** in addition to the default Workers permissions. If the first deploy fails with an authentication error on the migration step, edit the token under **Settings → Build → API token** and add D1 Edit. Non-production branches only run the checks and a dry-run bundle; they never upload a version, because previews would share the production D1 database and `APP_URL`. Enable non-production builds so pull requests get a Cloudflare check status.

3. Create a [Discord application](https://discord.com/developers/applications). Under OAuth2, add the exact redirect URL `https://YOUR-ORIGIN/auth/callback`. The app uses only the `identify` scope, not bot or server permissions.

4. For Twitch, create an application in the [Twitch developer console](https://dev.twitch.tv/console/apps). The Worker obtains app access tokens and subscribes to `stream.online` for channels people add. Callback: `https://YOUR-ORIGIN/hooks/twitch`. It verifies Twitch's HMAC signature and handles the callback challenge. Twitch's application OAuth redirect can be your site URL; this service does not use streamer OAuth.

5. For Kick, create an application in [Kick developer settings](https://kick.com/settings/developer). Enable webhooks and set the app webhook URL to `https://YOUR-ORIGIN/hooks/kick`. The Worker obtains an app access token, subscribes to `livestream.status.updated`, and checks Kick's RSA signatures using its public-key endpoint. Kick uses the webhook URL configured on the developer application, rather than a URL per subscription.

   You may configure only Twitch or only Kick; the dashboard disables platforms that are not configured.

6. Add runtime secrets in **Worker → Settings → Variables and Secrets**, each with type **Secret**. Saving them deploys a new version; `wrangler deploy` from later builds keeps them.

   | Secret                                       | Value                                                  |
   | -------------------------------------------- | ------------------------------------------------------ |
   | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | From the Discord application                           |
   | `ENCRYPTION_KEY`                             | 32 random bytes, base64 encoded                        |
   | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`   | From the Twitch application                            |
   | `TWITCH_WEBHOOK_SECRET`                      | A **different** random string, 32–100 ASCII characters |
   | `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`       | From the Kick application                              |

   Generate random values with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (any Claude Code session can run it). Keep a secure backup of `ENCRYPTION_KEY`; changing it makes existing saved webhook URLs unreadable. Never commit secrets.

7. Open the site and connect Discord. In Discord, edit your destination channel → **Integrations → Webhooks → New Webhook → Copy Webhook URL**. Enter that URL, a streaming channel, and a message in the site. Click **Create alert**, then **Send test**. Check Recent deliveries and the Discord channel. Test notifications really post a message.

You can add a custom domain through the Worker settings. If the origin changes, update `APP_URL`, Discord's redirect URL, and Kick's callback URL. Existing Twitch subscriptions also need removal/recreation because their callbacks retain the previous origin. Use a dedicated developer app for this installation.

## Development

Development happens in [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web). Open the repository in a cloud session with the default (trusted) network access. The `SessionStart` hook in `.claude/settings.json` runs `npm ci` in cloud sessions, so `npm run verify` works immediately. [`CLAUDE.md`](CLAUDE.md) holds the project conventions the agent follows.

Workflow: a session works on its own branch and opens a pull request. Workers Builds runs `npm run verify` and a dry-run bundle on the branch and reports the result on the pull request. Merging to `main` migrates D1 and deploys. Cloud sessions never need Cloudflare credentials or production secrets; all external APIs are mocked in tests.

### Running the Worker locally

Optional, on a machine with Node 22+:

```sh
npm ci
cp .dev.vars.example .dev.vars
# Fill in local secrets; never commit .dev.vars.
npm run db:local
npm run dev
```

Visit `http://localhost:8787`. Register `http://localhost:8787/auth/callback` as a Discord OAuth redirect to exercise sign-in locally. The default `APP_URL` is the localhost origin; production must use HTTPS. Twitch/Kick cannot deliver callbacks to localhost. To test push delivery, expose the Worker through a public HTTPS development origin and update `APP_URL` and the developer application URLs. Prefer separate development provider applications.

Wrangler local dev does not fire cron automatically. Start `npm run dev -- --test-scheduled` and trigger the local cron with `curl 'http://localhost:8787/__scheduled'`. Production uses the configured Cloudflare Cron Trigger.

## Behavior and limits

- A channel has one shared provider monitor. Every matching enabled user rule has its own private Discord destination and outbox record. User-supplied destinations are restricted to canonical `https://discord.com/api/webhooks/...` URLs; external redirects and arbitrary fetch targets are rejected.
- Webhook URLs are AES-GCM encrypted at rest. They are never returned by the dashboard API. Sessions are hashed, HttpOnly, SameSite cookies; production cookies are Secure. Write requests require the configured same-origin Origin header. OAuth state is random, single-use, expires after ten minutes, and is tied to the browser cookie.
- Message placeholders: `{channel}`, `{platform}`, `{title}`, `{game}`, `{url}`. The game/category is shown on the dashboard and can be included with `{game}`. Missing categories display as “Not specified” in announcements. Include `@everyone` in an alert message to enable Discord everyone mentions (including in test notifications). Without it, mentions are suppressed even if stream metadata contains them. User and role mentions remain disabled. Notifications contain only the configured message with placeholders replaced, including tests. No custom embeds are sent; Discord controls automatic link previews.
- Adding or resuming an alert while a stream is already live arms it for the **next** broadcast. Tests also work while an alert is paused. Separate Twitch and Kick rules send separate announcements; there is no cross-platform merging.
- Signed push events are the main trigger. Once per minute, reconciliation checks up to 50 channels in bulk, rotating through oldest-checked channels fairly. With more than 50 channels, fallback polling takes multiple minutes. Cloudflare Cron itself is approximate. A short stream can be missed if push delivery fails and it ends between polls.
- Up to three channel subscriptions are repaired per minute; active subscriptions are rechecked every six hours, failed subscriptions about hourly. Subscriptions for channels without active rules are removed, up to two per tick. Polling continues if webhook registration fails. Provider configuration changes may require deleting stale subscriptions in the provider console.
- Each rule/broadcast has a unique database deduplication key, shared by push and polling. The outbox claims deliveries atomically, retries transient failures and Discord 429s with backoff, and treats 400/401/403/404 as permanent failures. Normal cron drains up to 10 pending deliveries per tick; incoming webhooks also attempt two. Notifications expire after six hours or eight attempts. A crashed in-flight delivery becomes eligible again after two minutes.
- Delivery is **at least once**, not exactly once: if Discord accepts a message and a connection/Worker fails before D1 records success, a retry may duplicate the message. The system prevents normal duplicate webhook/poll announcements; Discord incoming webhooks do not provide transactional idempotency.
- Queued messages are cancelled when a rule is edited or paused. A delivery already in flight may still complete. Delete removes the rule and associated history. The latest 30 deliveries appear in the dashboard. Deduplication keys are retained while the rule exists; terminal payloads are cleared after 30 days.
- Default limit: 20 alerts per account (`MAX_RULES_PER_USER`). Writes, new rules, login starts, and tests are rate-limited; test buttons have a one-minute cooldown per rule. These are modest abuse controls, not a billing cap. For a large public service, monitor Workers/D1/API quotas, use platform rate-limit rules, and move high-volume fan-out/delivery into Cloudflare Queues. This version is intended for small communities, not unlimited scale.
- No credentials or live accounts are included. Live OAuth, upstream subscriptions, and Discord delivery must be verified after you supply credentials and deploy. Integration tests mock external APIs and use local D1 in Miniflare; they do not post real Discord messages.

## Checks

Integration tests start temporary localhost servers and disposable D1 databases. The runtime test completes Discord sign-in against mocked endpoints inside workerd, exercising the actual fetch implementation. No production database or credentials are used.

```sh
npm run verify
npx wrangler deploy --dry-run
```

`npm run verify` runs syntax checks, Prettier, and the test suite. Tests cover account isolation, cross-origin request rejection, rule CRUD, encrypted destinations, alert limits, live-session deduplication, paused alerts, Discord test cooldowns, retry/error behavior, Twitch challenge/signature verification, Kick RSA verification, and the scheduled monitor. Workers Builds runs the same commands on every push; a failure blocks the production deploy.

## Source layout

- `src/index.js`: request routing, authenticated rule API, and security headers for every response, including static assets.
- `src/auth.js`: Discord OAuth, login diagnostics, and sessions.
- `src/monitor.js`: signed webhooks, channel reconciliation, subscription maintenance, and durable delivery retries.
- `src/http.js`: shared request, response, cookie, and database helpers.
- `src/discord.js`: shared destination validation and encryption.
- `src/providers.js`: official Twitch/Kick API access, app token caching, subscriptions, channel lookup, and Kick public-key verification.
- `src/security.js`: authenticated encryption, HMAC validation, input validation, and Discord payloads.
- `public/`: responsive buildless dashboard; no browser framework or third-party scripts.
- `migrations/`: D1 schema.
- `test/`: Node's test runner, local D1 integration tests, and a Worker runtime OAuth regression test.
- `CLAUDE.md`, `.claude/`: agent instructions and the cloud session setup hook.

Official references: [Cloudflare Workers](https://developers.cloudflare.com/workers/), [D1](https://developers.cloudflare.com/d1/), [Twitch EventSub](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/), [Kick API and events](https://github.com/KickEngineering/KickDevDocs), [Discord webhooks](https://discord.com/developers/docs/resources/webhook), [Discord OAuth2](https://discord.com/developers/docs/topics/oauth2).

## Database migrations

Schema changes are new numbered files in `migrations/`. The production deploy applies pending migrations before uploading the Worker, so the previous Worker version briefly runs against the new schema: keep migrations additive (new tables, nullable or defaulted columns) and never edit a migration that has already shipped. Already queued announcements keep their original payload.
