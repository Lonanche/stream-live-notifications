import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChannel, ensureSubscription, pollChannels, requestJSON } from '../src/providers.js';
test('API requests use Workers-compatible redirect handling and reject redirects', async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    // Workers rejects redirect: 'error' before making any network request.
    if (options.redirect === 'error') throw new TypeError('Unsupported redirect mode');
    assert.equal(options.redirect, 'manual');
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/redirect-target' },
    });
  };
  await assert.rejects(requestJSON('https://discord.com/api/v10/oauth2/token'), {
    name: 'Error',
    status: 302,
  });
  assert.equal(calls, 1);
});
test('Kick lookup, app subscription, and offline polling use the official API', async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const env = { KICK_CLIENT_ID: 'kick-fixture', KICK_CLIENT_SECRET: 'secret' };
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    requests.push({ u, options });
    if (u.hostname === 'id.kick.com')
      return Response.json({ access_token: 'kick-token', expires_in: 3600 });
    if (u.pathname === '/public/v1/channels')
      return Response.json({
        data: [
          {
            broadcaster_user_id: 42,
            slug: 'example',
            stream: { is_live: false, start_time: '0001-01-01T00:00:00Z' },
            stream_title: 'Next stream',
            category: { name: 'Just Chatting' },
          },
        ],
      });
    if (u.pathname === '/public/v1/events/subscriptions')
      return Response.json({
        data:
          options.method === 'POST'
            ? [{ name: 'livestream.status.updated', subscription_id: 'kick-sub', version: 1 }]
            : [],
      });
    throw new Error('Unexpected provider endpoint');
  };
  const channel = await resolveChannel('kick', 'example', env);
  assert.equal(channel.broadcaster_id, '42');
  assert.equal(channel.live, false);
  assert.equal(channel.game, 'Just Chatting');
  assert.equal(channel.stream_key, null);
  const sub = await ensureSubscription(channel, env);
  assert.equal(sub.id, 'kick-sub');
  const body = JSON.parse(
    requests.find((r) => r.options.method === 'POST' && r.u.hostname === 'api.kick.com').options
      .body
  );
  assert.equal(body.broadcaster_user_id, 42);
  assert.deepEqual(body.events, [{ name: 'livestream.status.updated', version: 1 }]);
  const polled = await pollChannels('kick', [channel], env);
  assert.equal(polled[0].live, false);
  assert.equal(polled[0].game, 'Just Chatting');
  assert.equal(requests.at(-1).u.searchParams.get('broadcaster_user_id'), '42');
  assert.equal(requests.filter((r) => r.u.hostname === 'id.kick.com').length, 1);
});

test('live Twitch and Kick API metadata carries game through lookup and backup polling', async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const env = {
    TWITCH_CLIENT_ID: 'game-test',
    TWITCH_CLIENT_SECRET: 'secret',
    KICK_CLIENT_ID: 'game-test',
    KICK_CLIENT_SECRET: 'secret',
  };
  const started = new Date().toISOString();
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname.startsWith('id.'))
      return Response.json({ access_token: 'token', expires_in: 3600 });
    if (u.pathname === '/helix/users')
      return Response.json({ data: [{ id: '42', login: 'example' }] });
    if (u.pathname === '/helix/streams')
      return Response.json({
        data: [{ user_id: '42', title: 'Fresh wipe', game_name: 'Rust', started_at: started }],
      });
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
  };
  for (const platform of ['twitch', 'kick']) {
    const channel = await resolveChannel(platform, 'example', env);
    assert.equal(channel.game, 'Rust');
    assert.equal(channel.title, 'Fresh wipe');
    const polled = (await pollChannels(platform, [channel], env))[0];
    assert.equal(polled.game, 'Rust');
    assert.equal(polled.live, true);
  }
});
