import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  webhookURL,
  channelSlug,
  encrypt,
  decrypt,
  discordPayload,
  verifyTwitch,
  bytes,
  b64,
} from '../src/security.js';
import { verifyKick } from '../src/providers.js';
const key = b64(new Uint8Array(32).fill(7));
const hook = 'https://discord.com/api/webhooks/123456789012345678/' + 'x'.repeat(68);
test('only canonical Discord webhook destinations are accepted', () => {
  assert.equal(webhookURL(hook), hook);
  for (const url of [
    'http://discord.com/api/webhooks/123456789012345678/' + 'x'.repeat(68),
    'https://discord.com.evil.test/api/webhooks/123456789012345678/' + 'x'.repeat(68),
    hook + '?thread_id=123',
    hook + '#fragment',
    'https://127.0.0.1/',
    hook.replace('discord.com', 'discord.com:444'),
  ])
    assert.throws(() => webhookURL(url));
});
test('channel parsing matches selected platform', () => {
  assert.equal(channelSlug('kick', 'https://kick.com/Example'), 'example');
  assert.equal(channelSlug('twitch', 'https://www.twitch.tv/some_user/'), 'some_user');
  assert.throws(() => channelSlug('kick', 'https://twitch.tv/example'));
  assert.throws(() => channelSlug('twitch', '../admin'));
});
test('webhooks are authenticated-encrypted with random IVs', async () => {
  const a = await encrypt(hook, key),
    b = await encrypt(hook, key);
  assert.notEqual(a, b);
  assert.ok(!a.includes(hook));
  assert.equal(await decrypt(a, key), hook);
  await assert.rejects(decrypt(a, b64(new Uint8Array(32).fill(9))));
});
test('templates replace known fields once and enable everyone mentions when explicitly requested', () => {
  const p = discordPayload(
    { message: '@everyone {channel} {title} {url}' },
    { platform: 'kick', slug: 'example' },
    { title: '{channel} @here' }
  );
  assert.equal(p.content, '@everyone example {channel} @here https://kick.com/example');
  assert.deepEqual(p.allowed_mentions, { parse: ['everyone'] });
  const rule = { message: '@everyone {title}' };
  const channel = { platform: 'kick', slug: 'example' };
  assert.deepEqual(discordPayload(rule, channel, {}).allowed_mentions, {
    parse: ['everyone'],
  });
  const withoutMention = discordPayload({ message: '{title}' }, channel, { title: '@everyone' });
  assert.deepEqual(withoutMention.allowed_mentions, { parse: [] });
});
test('Twitch signatures reject tampering and stale timestamps', async () => {
  const time = new Date().toISOString(),
    body = '{"hello":true}',
    secret = 'test-secret-with-at-least-32-characters',
    id = 'message-id';
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(id + time + body)));
  const signature = 'sha256=' + [...sig].map((x) => x.toString(16).padStart(2, '0')).join('');
  const r = new Request('https://app.test/hooks/twitch', {
    headers: {
      'Twitch-Eventsub-Message-Id': id,
      'Twitch-Eventsub-Message-Timestamp': time,
      'Twitch-Eventsub-Message-Signature': signature,
    },
  });
  assert.equal(await verifyTwitch(r, body, secret), true);
  assert.equal(await verifyTwitch(r, body + 'x', secret), false);
  assert.equal(await verifyTwitch(r, body, secret, Date.now() + 660000), false);
});
test('Kick RSA signatures use dynamically fetched provider public key', async () => {
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
  const time = new Date().toISOString(),
    body = '{"is_live":true}',
    id = 'kick-id';
  const sig = b64(
    new Uint8Array(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        bytes(id + '.' + time + '.' + body)
      )
    )
  );
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: { public_key: pem } });
  try {
    const r = new Request('https://app.test/hooks/kick', {
      headers: {
        'Kick-Event-Message-Id': id,
        'Kick-Event-Message-Timestamp': time,
        'Kick-Event-Signature': sig,
      },
    });
    assert.equal(await verifyKick(r, body), true);
    assert.equal(await verifyKick(r, body + 'x'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('text-only notifications replace game placeholders for both platforms, including missing categories', () => {
  for (const platform of ['twitch', 'kick']) {
    const rule = { message: '{channel} playing {game}: {title} {url}' };
    const channel = { platform, slug: 'example' };
    const payload = discordPayload(rule, channel, { title: 'Fresh wipe', game: 'Rust' });
    assert.ok(payload.content.includes('example playing Rust: Fresh wipe'));
    assert.equal('embeds' in payload, false);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    const absent = discordPayload(rule, channel, { title: 'Live' });
    assert.ok(absent.content.includes('playing Not specified'));
    assert.equal('embeds' in absent, false);
    const testPayload = discordPayload(rule, channel, { game: 'Just Chatting' });
    assert.equal(
      testPayload.content,
      'example playing Just Chatting: Live stream https://' +
        (platform === 'kick' ? 'kick.com' : 'twitch.tv') +
        '/example'
    );
    assert.equal('embeds' in testPayload, false);
  }
});
