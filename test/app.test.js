import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { observe, drain, scheduled } from '../src/index.js';
import { hash, b64, bytes } from '../src/security.js';
import { database } from './helpers.js';
const hook = 'https://discord.com/api/webhooks/123456789012345678/' + 'x'.repeat(68);
async function setup(t) {
  const DB = await database();
  t.after(() => DB.close());
  const env = {
    DB,
    APP_URL: 'https://app.test',
    DISCORD_CLIENT_ID: 'discord-app',
    DISCORD_CLIENT_SECRET: 'discord-secret',
    ENCRYPTION_KEY: b64(new Uint8Array(32).fill(7)),
    TWITCH_CLIENT_ID: 'twitch-app',
    TWITCH_CLIENT_SECRET: 'secret',
    TWITCH_WEBHOOK_SECRET: 'test-secret-with-32-characters-minimum',
    MAX_RULES_PER_USER: '2',
    ASSETS: { fetch: async () => new Response('static') },
  };
  for (const id of ['alice', 'bob']) {
    await DB.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)')
      .bind(id, id, Date.now())
      .run();
    await DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
      .bind(await hash(id), id, Date.now() + 60000)
      .run();
  }
  const tasks = [];
  const ctx = { waitUntil: (task) => tasks.push(task) };
  const original = globalThis.fetch;
  let posts = 0,
    discordStatus = 200;
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/v10/oauth2/token')
      return Response.json({ access_token: 'oauth-token' });
    if (u.pathname === '/api/v10/users/@me')
      return Response.json({ id: 'discord-user', username: 'discordname' });
    if (u.hostname === 'id.twitch.tv')
      return Response.json({ access_token: 'token', expires_in: 3600 });
    if (u.pathname === '/helix/users')
      return Response.json({ data: [{ id: '42', login: 'example' }] });
    if (u.pathname === '/helix/streams') return Response.json({ data: [] });
    if (u.pathname === '/helix/eventsub/subscriptions')
      return Response.json({ data: [{ id: 'sub-1', status: 'enabled' }] });
    if (u.hostname === 'discord.com' && u.pathname.includes('/webhooks/')) {
      if (options.method === 'POST') {
        posts++;
        return Response.json(discordStatus === 429 ? { retry_after: 60 } : { id: 'message' }, {
          status: discordStatus,
        });
      }
      return Response.json({ type: 1, channel_id: '123456789012345678' });
    }
    throw new Error('Unexpected external request: ' + u.origin + u.pathname);
  };
  t.after(() => (globalThis.fetch = original));
  const request = (path, method = 'GET', data, user = 'alice', origin = env.APP_URL) =>
    worker.fetch(
      new Request(env.APP_URL + path, {
        method,
        headers: { Cookie: 'session=' + user, Origin: origin, 'Content-Type': 'application/json' },
        ...(data ? { body: JSON.stringify(data) } : {}),
      }),
      env,
      ctx
    );
  const create = () =>
    request('/api/rules', 'POST', {
      platform: 'twitch',
      channel: 'example',
      webhook: hook,
      message: '{channel} live! {url}',
    });
  return {
    env,
    request,
    create,
    settle: () => Promise.all(tasks.splice(0)),
    posts: () => posts,
    setStatus: (s) => (discordStatus = s),
  };
}
test('private dashboard rejects anonymous and cross-origin mutations', async (t) => {
  const { request } = await setup(t);
  assert.equal((await request('/api/rules', 'GET', null, 'stranger')).status, 401);
  assert.equal((await request('/api/rules', 'POST', {}, 'alice', 'https://evil.test')).status, 403);
});
test('create, edit, pause, test, delete and account isolation', async (t) => {
  const s = await setup(t);
  const created = await s.create();
  assert.equal(created.status, 201);
  const { id } = await created.json();
  await s.settle();
  const data = await (await s.request('/api/rules')).json();
  assert.equal(data.rules.length, 1);
  assert.ok(!JSON.stringify(data).includes(hook));
  assert.equal(data.rules[0].subscription_status, 'enabled');
  assert.equal((await (await s.request('/api/rules', 'GET', null, 'bob')).json()).rules.length, 0);
  for (const method of ['PATCH', 'DELETE'])
    assert.equal(
      (await s.request('/api/rules/' + id, method, { enabled: false }, 'bob')).status,
      404
    );
  assert.equal(
    (await s.request('/api/rules/' + id, 'PATCH', { enabled: false, message: 'Updated {url}' }))
      .status,
    200
  );
  assert.equal((await s.request('/api/rules/' + id + '/test', 'POST')).status, 200);
  await s.settle();
  assert.equal(s.posts(), 1);
  assert.equal((await s.request('/api/rules/' + id + '/test', 'POST')).status, 429);
  assert.equal((await s.request('/api/rules/' + id, 'DELETE')).status, 200);
  assert.equal((await s.request('/api/rules/' + id, 'DELETE')).status, 404);
});
test('per-user alert limit is enforced', async (t) => {
  const s = await setup(t);
  assert.equal((await s.create()).status, 201);
  await s.settle();
  assert.equal((await s.create()).status, 201);
  await s.settle();
  assert.equal((await s.create()).status, 409);
});
test('duplicate events and backup polls yield one delivery per rule and broadcast', async (t) => {
  const s = await setup(t);
  const { id } = await (await s.create()).json();
  await s.settle();
  const channel = await s.env.DB.prepare('SELECT * FROM channels').first();
  const stream = {
    live: true,
    title: 'Live now',
    game: 'Rust',
    stream_key: new Date(Date.now() + 1000).toISOString(),
  };
  await observe(s.env, channel, stream);
  await observe(s.env, channel, stream);
  let deliveries = (await s.env.DB.prepare('SELECT * FROM deliveries').all()).results;
  assert.equal(deliveries.length, 1);
  assert.equal('embeds' in JSON.parse(deliveries[0].payload), false);
  assert.equal((await s.env.DB.prepare('SELECT game FROM channels').first()).game, 'Rust');
  const dashboard = await (await s.request('/api/rules')).json();
  assert.equal(dashboard.rules[0].game, 'Rust');
  await Promise.all([drain(s.env), drain(s.env)]);
  assert.equal(s.posts(), 1);
  assert.equal((await s.env.DB.prepare('SELECT state FROM deliveries').first()).state, 'sent');
  await observe(s.env, channel, {
    ...stream,
    stream_key: new Date(Date.now() - 60000).toISOString(),
  });
  assert.equal((await s.env.DB.prepare('SELECT count(*) AS n FROM deliveries').first()).n, 1);
  assert.equal((await s.request('/api/rules/' + id, 'PATCH', { enabled: false })).status, 200);
  await observe(s.env, channel, {
    ...stream,
    stream_key: new Date(Date.now() + 2000).toISOString(),
  });
  assert.equal((await s.env.DB.prepare('SELECT count(*) AS n FROM deliveries').first()).n, 1);
});
test('429 retries are durable; permanent Discord errors are visible without leaking tokens', async (t) => {
  const s = await setup(t);
  await s.create();
  await s.settle();
  const c = await s.env.DB.prepare('SELECT * FROM channels').first();
  await observe(s.env, c, {
    live: true,
    title: 'test',
    stream_key: new Date(Date.now() + 1000).toISOString(),
  });
  s.setStatus(429);
  await drain(s.env);
  const d = await s.env.DB.prepare('SELECT * FROM deliveries').first();
  assert.equal(d.state, 'pending');
  assert.equal(d.attempts, 1);
  assert.ok(d.due_at > Date.now() + 55000);
  assert.ok(!d.error.includes('xxx'));
  await s.env.DB.prepare('UPDATE deliveries SET due_at=0').run();
  s.setStatus(404);
  await drain(s.env);
  assert.equal((await s.env.DB.prepare('SELECT state FROM deliveries').first()).state, 'failed');
});
test('signed Twitch challenge is answered and unsigned events rejected', async (t) => {
  const s = await setup(t);
  await s.create();
  await s.settle();
  const body = JSON.stringify({
      subscription: {
        id: 'sub-1',
        type: 'stream.online',
        version: '1',
        condition: { broadcaster_user_id: '42' },
      },
      challenge: 'hello',
    }),
    time = new Date().toISOString(),
    id = 'event-1';
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(s.env.TWITCH_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(id + time + body)));
  const signature = 'sha256=' + [...sig].map((x) => x.toString(16).padStart(2, '0')).join('');
  const headers = {
    'Twitch-Eventsub-Message-Id': id,
    'Twitch-Eventsub-Message-Timestamp': time,
    'Twitch-Eventsub-Message-Signature': signature,
    'Twitch-Eventsub-Message-Type': 'webhook_callback_verification',
  };
  const r = await worker.fetch(
    new Request('https://app.test/hooks/twitch', { method: 'POST', headers, body }),
    s.env,
    { waitUntil: () => {} }
  );
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'hello');
  assert.equal(
    (
      await worker.fetch(
        new Request('https://app.test/hooks/twitch', { method: 'POST', body }),
        s.env,
        { waitUntil: () => {} }
      )
    ).status,
    403
  );
});
test('scheduled monitor checks channels, drains queue and cleans expired state', async (t) => {
  const s = await setup(t);
  await s.create();
  await s.settle();
  await scheduled(s.env);
  assert.equal((await s.env.DB.prepare('SELECT count(*) AS n FROM leases').first()).n, 0);
  assert.ok((await s.env.DB.prepare('SELECT checked_at FROM channels').first()).checked_at > 0);
});

test('one shared channel fans out privately to two accounts', async (t) => {
  const s = await setup(t);
  await s.create();
  await s.settle();
  const response = await s.request(
    '/api/rules',
    'POST',
    {
      platform: 'twitch',
      channel: 'example',
      webhook: hook,
      message: 'Bob says {channel} is live',
    },
    'bob'
  );
  assert.equal(response.status, 201);
  await s.settle();
  assert.equal((await s.env.DB.prepare('SELECT count(*) AS n FROM channels').first()).n, 1);
  const c = await s.env.DB.prepare('SELECT * FROM channels').first();
  await observe(s.env, c, {
    live: true,
    title: 'Community stream',
    stream_key: new Date(Date.now() + 1000).toISOString(),
  });
  await Promise.all([drain(s.env), drain(s.env)]);
  assert.equal(s.posts(), 2);
  for (const user of ['alice', 'bob']) {
    const dashboard = await (await s.request('/api/rules', 'GET', null, user)).json();
    assert.equal(dashboard.rules.length, 1);
    assert.equal(dashboard.history.length, 1);
    assert.equal(dashboard.history[0].rule_id, dashboard.rules[0].id);
  }
});

test('Discord OAuth state is browser-bound, single-use, and creates a secure session', async (t) => {
  const s = await setup(t);
  const login = await s.request('/auth/login');
  assert.equal(login.status, 302);
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  assert.ok(state);
  const callback = (browserState) =>
    worker.fetch(
      new Request(
        'https://app.test/auth/callback?' + new URLSearchParams({ code: 'code', state }),
        { headers: { Cookie: 'oauth_state=' + browserState } }
      ),
      s.env,
      { waitUntil: () => {} }
    );
  assert.equal((await callback('wrong-browser')).headers.get('Location'), '/?error=login');
  const result = await callback(state);
  assert.equal(result.headers.get('Location'), '/');
  const session = result.headers.get('Set-Cookie');
  assert.ok(session.includes('HttpOnly'));
  assert.ok(session.includes('Secure'));
  const token = session.match(/session=([^;]+)/)[1];
  const me = await worker.fetch(
    new Request('https://app.test/api/me', { headers: { Cookie: 'session=' + token } }),
    s.env,
    { waitUntil: () => {} }
  );
  assert.equal((await me.json()).user.id, 'discord-user');
  assert.equal((await callback(state)).headers.get('Location'), '/?error=login');
});

for (const metadataFails of [false, true]) {
  test(`signed Kick live events deliver when metadata ${metadataFails ? 'fails' : 'succeeds'}`, async (t) => {
    const s = await setup(t);
    await s.create();
    await s.settle();
    s.env.KICK_CLIENT_ID = 'kick-hook-test';
    s.env.KICK_CLIENT_SECRET = 'secret';
    await s.env.DB.prepare(
      "INSERT INTO channels(platform,broadcaster_id,slug,game) VALUES('kick','42','example','Old category')"
    ).run();
    await s.env.DB.prepare("UPDATE rules SET platform='kick' WHERE user_id='alice'").run();
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );
    const pem =
      '-----BEGIN PUBLIC KEY-----\n' +
      b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))) +
      '\n-----END PUBLIC KEY-----';
    const timestamp = new Date().toISOString(),
      started = new Date(Date.now() + 1000).toISOString();
    const body = JSON.stringify({
      broadcaster: { user_id: 42 },
      is_live: true,
      started_at: started,
      title: 'Fresh wipe',
    });
    const id = 'kick-game-event';
    const signature = b64(
      new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          pair.privateKey,
          bytes(id + '.' + timestamp + '.' + body)
        )
      )
    );
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const u = new URL(url);
      if (u.pathname === '/public/v1/public-key')
        return Response.json({ data: { public_key: pem } });
      if (u.hostname === 'id.kick.com')
        return Response.json({ access_token: 'token', expires_in: 3600 });
      if (u.pathname === '/public/v1/channels' && metadataFails)
        return Response.json({ message: 'Unavailable' }, { status: 503 });
      if (u.pathname === '/public/v1/channels')
        return Response.json({
          data: [
            {
              broadcaster_user_id: 42,
              slug: 'example',
              stream_title: 'Fresh wipe',
              category: { name: 'Rust' },
              stream: { is_live: true, start_time: started },
            },
          ],
        });
      return previousFetch(url, options);
    };
    const tasks = [];
    const response = await worker.fetch(
      new Request('https://app.test/hooks/kick', {
        method: 'POST',
        body,
        headers: {
          'Kick-Event-Message-Id': id,
          'Kick-Event-Message-Timestamp': timestamp,
          'Kick-Event-Signature': signature,
          'Kick-Event-Type': 'livestream.status.updated',
          'Kick-Event-Version': '1',
        },
      }),
      s.env,
      { waitUntil: (p) => tasks.push(p) }
    );
    assert.equal(response.status, 204);
    await Promise.all(tasks);
    const delivery = await s.env.DB.prepare('SELECT * FROM deliveries').first();
    assert.equal(
      (await s.env.DB.prepare("SELECT game FROM channels WHERE platform='kick'").first()).game,
      metadataFails ? 'Old category' : 'Rust'
    );
    assert.equal(delivery.state, 'sent');
  });
}

test('previously queued embeds are removed before Discord delivery', async (t) => {
  const s = await setup(t);
  const { id } = await (await s.create()).json();
  await s.settle();
  await s.env.DB.prepare(
    'INSERT INTO deliveries(id,rule_id,stream_key,payload,due_at,created_at) VALUES(?,?,?,?,?,?)'
  )
    .bind(
      'legacy-delivery',
      id,
      'legacy-stream',
      JSON.stringify({
        content: 'My exact announcement https://kick.com/example',
        embeds: [{ title: 'Old embed' }],
        allowed_mentions: { parse: [] },
      }),
      Date.now(),
      Date.now()
    )
    .run();
  const previousFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST' && new URL(url).hostname === 'discord.com')
      sent = JSON.parse(options.body);
    return previousFetch(url, options);
  };
  await drain(s.env);
  assert.equal(sent.content, 'My exact announcement https://kick.com/example');
  assert.equal('embeds' in sent, false);
});
