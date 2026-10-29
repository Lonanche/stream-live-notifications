import { hash, channelSlug, messageTemplate, discordPayload } from './security.js';
import { ProviderError, resolveChannel } from './providers.js';
import { verifyDestination } from './discord.js';
import {
  now,
  json,
  fail,
  statement,
  first,
  all,
  run,
  cookie,
  cookieHeader,
  bodyJSON,
  rateLimit,
} from './http.js';
import { auth, userFor } from './auth.js';
import { hooks, drain, scheduled, synchronizeSubscription } from './monitor.js';
export { observe, drain, scheduled } from './monitor.js';
async function apiRoute(request, env, path, ctx) {
  const user = await userFor(request, env);
  if (path === '/api/me' && request.method === 'GET')
    return json({
      user,
      platforms: {
        twitch: !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET),
        kick: !!(env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET),
      },
      ready: !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.ENCRYPTION_KEY),
    });
  if (!user) throw fail('Sign in to manage your alerts.', 401);
  if (request.method !== 'GET') {
    if (request.headers.get('Origin') !== env.APP_URL) throw fail('Invalid request origin.', 403);
    await rateLimit(env, 'write:' + user.id, 40);
  }
  if (path === '/api/logout' && request.method === 'POST') {
    await run(
      env,
      'DELETE FROM sessions WHERE token_hash=?',
      await hash(cookie(request, 'session'))
    );
    return new Response('{}', {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieHeader(env, 'session', '', 0),
      },
    });
  }
  if (path === '/api/rules' && request.method === 'GET') {
    const rules = await all(
      env,
      `SELECT r.id,r.platform,r.message,r.enabled,r.destination,r.created_at,c.slug,c.live,c.title,c.game,c.checked_at,c.subscription_status,c.error FROM rules r JOIN channels c ON c.platform=r.platform AND c.broadcaster_id=r.broadcaster_id WHERE r.user_id=? ORDER BY r.created_at DESC`,
      user.id
    );
    const history = await all(
      env,
      `SELECT d.id,d.rule_id,d.state,d.attempts,d.created_at,d.sent_at,d.error,r.platform,c.slug FROM deliveries d JOIN rules r ON r.id=d.rule_id JOIN channels c ON c.platform=r.platform AND c.broadcaster_id=r.broadcaster_id WHERE r.user_id=? ORDER BY d.created_at DESC LIMIT 30`,
      user.id
    );
    return json({ rules, history });
  }
  if (path === '/api/rules' && request.method === 'POST') {
    const input = await bodyJSON(request);
    const platform = input.platform,
      slug = channelSlug(platform, input.channel),
      message = messageTemplate(input.message);
    const count = await first(env, 'SELECT count(*) AS n FROM rules WHERE user_id=?', user.id);
    const max = Math.min(100, Math.max(1, Number(env.MAX_RULES_PER_USER) || 20));
    if (count.n >= max) throw fail(`You can create up to ${max} alerts.`, 409);
    await rateLimit(env, 'create:' + user.id, 10);
    const channel = await resolveChannel(platform, slug, env);
    const { encrypted, destination } = await verifyDestination(input.webhook, env);
    const id = crypto.randomUUID(),
      created = now();
    const results = await env.DB.batch([
      statement(
        env,
        `INSERT INTO channels(platform,broadcaster_id,slug,live,stream_key,title,game,checked_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(platform,broadcaster_id) DO UPDATE SET slug=excluded.slug`,
        platform,
        channel.broadcaster_id,
        channel.slug,
        channel.live ? 1 : 0,
        channel.stream_key,
        channel.title,
        channel.game,
        created
      ),
      // A conditional insert enforces the per-user cap even for concurrent requests.
      statement(
        env,
        `INSERT INTO rules(id,user_id,platform,broadcaster_id,webhook,destination,message,created_at,activated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM rules WHERE user_id=?)<?`,
        id,
        user.id,
        platform,
        channel.broadcaster_id,
        encrypted,
        destination,
        message,
        created,
        created,
        user.id,
        max
      ),
    ]);
    if (!results[1].meta.changes) throw fail(`You can create up to ${max} alerts.`, 409);
    ctx.waitUntil(synchronizeSubscription(env, channel));
    return json({ id }, 201);
  }
  const match = path.match(/^\/api\/rules\/([a-f0-9-]{36})(\/test)?$/);
  if (match) {
    const rule = await first(
      env,
      'SELECT r.*,c.slug,c.game FROM rules r JOIN channels c ON c.platform=r.platform AND c.broadcaster_id=r.broadcaster_id WHERE r.id=? AND r.user_id=?',
      match[1],
      user.id
    );
    if (!rule) throw fail('Alert not found.', 404);
    if (match[2] && request.method === 'POST') {
      const eligible = await first(
        env,
        'UPDATE rules SET test_at=? WHERE id=? AND user_id=? AND test_at<? RETURNING id',
        now(),
        rule.id,
        user.id,
        now() - 60000
      );
      if (!eligible) throw fail('Wait one minute between test notifications.', 429);
      const key = 'test:' + crypto.randomUUID();
      await run(
        env,
        'INSERT INTO deliveries(id,rule_id,stream_key,payload,due_at,created_at) VALUES(?,?,?,?,?,?)',
        crypto.randomUUID(),
        rule.id,
        key,
        JSON.stringify(
          discordPayload(rule, rule, { title: `${rule.slug} is live!`, game: rule.game })
        ),
        now(),
        now()
      );
      ctx.waitUntil(drain(env, 2));
      return json({ queued: true });
    }
    if (!match[2] && request.method === 'DELETE') {
      await run(env, 'DELETE FROM rules WHERE id=? AND user_id=?', rule.id, user.id);
      return json({ deleted: true });
    }
    if (!match[2] && request.method === 'PATCH') {
      const input = await bodyJSON(request);
      const message = input.message === undefined ? rule.message : messageTemplate(input.message);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
        throw fail('Invalid enabled value.');
      const enabled = input.enabled === undefined ? rule.enabled : input.enabled ? 1 : 0;
      const activation = enabled && !rule.enabled ? now() : rule.activated_at;
      let hook = rule.webhook,
        destination = rule.destination;
      if (input.webhook) {
        const verified = await verifyDestination(input.webhook, env);
        destination = verified.destination;
        hook = verified.encrypted;
      }
      await env.DB.batch([
        statement(
          env,
          'UPDATE rules SET enabled=?,activated_at=?,message=?,webhook=?,destination=? WHERE id=? AND user_id=?',
          enabled,
          activation,
          message,
          hook,
          destination,
          rule.id,
          user.id
        ),
        // A queued announcement should never be sent with an outdated destination or message.
        statement(
          env,
          "UPDATE deliveries SET state='cancelled',error='Alert settings changed.' WHERE rule_id=? AND state='pending'",
          rule.id
        ),
      ]);
      return json({ updated: true });
    }
  }
  throw fail('Not found.', 404);
}
async function route(request, env, ctx) {
  const url = new URL(request.url);
  // APP_URL is the canonical origin: it must not contain a path or trailing slash.
  if (!env.APP_URL || new URL(env.APP_URL).origin !== env.APP_URL)
    throw fail('Site origin is not configured correctly.', 503);
  if (url.pathname.startsWith('/auth/') && request.method === 'GET')
    return auth(request, env, url.pathname);
  if (url.pathname.startsWith('/hooks/') && request.method === 'POST')
    return hooks(request, env, url.pathname, ctx);
  if (url.pathname.startsWith('/api/')) return apiRoute(request, env, url.pathname, ctx);
  if (url.pathname.startsWith('/hooks/') || url.pathname.startsWith('/auth/'))
    throw fail('Method not allowed.', 405);
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (error) {
      const external = error instanceof ProviderError;
      const status = external ? (error.status === 404 ? 404 : 503) : error.status || 500;
      response = json(
        {
          error: status === 500 ? 'Something went wrong. Please try again.' : error.message,
        },
        status
      );
      if (status === 500)
        console.error('Request failed', { path: new URL(request.url).pathname, type: error.name });
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (new URL(request.url).protocol === 'https:')
      headers.set('Strict-Transport-Security', 'max-age=31536000');
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scheduled(env));
  },
};
