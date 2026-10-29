import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { migrate } from './helpers.js';

test('Worker runtime completes Discord OAuth and protects API and asset responses', async (t) => {
  const modules = Object.fromEntries(
    readdirSync(new URL('../src/', import.meta.url))
      .filter((name) => name.endsWith('.js'))
      .map((name) => [
        `src/${name}`,
        {
          type: 'esm',
          contents: readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'),
        },
      ])
  );
  const text = (value) => ({ type: 'text', value });
  let tokenRequests = 0;
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: 'app-test',
          compatibilityDate: '2026-10-01',
          manifest: { mainModule: 'src/index.js', modules },
          env: {
            DB: { type: 'd1', id: 'runtime-db' },
            APP_URL: text('https://app.test'),
            DISCORD_CLIENT_ID: text('test-client'),
            DISCORD_CLIENT_SECRET: text('test-secret'),
            ENCRYPTION_KEY: text(Buffer.alloc(32, 7).toString('base64')),
            ASSETS: { type: 'fetcher', handler: () => new Response('static asset') },
          },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request) => {
              const url = new URL(request.url);
              if (url.href === 'https://discord.com/api/v10/oauth2/token') {
                tokenRequests++;
                assert.equal(request.method, 'POST');
                const body = new URLSearchParams(await request.text());
                assert.equal(body.get('redirect_uri'), 'https://app.test/auth/callback');
                assert.equal(body.get('client_secret'), 'test-secret');
                return Response.json({ access_token: 'test-token' });
              }
              if (url.href === 'https://discord.com/api/v10/users/@me') {
                assert.equal(request.headers.get('Authorization'), 'Bearer test-token');
                return Response.json({ id: 'runtime-user', username: 'Runtime User' });
              }
              throw new Error('Unexpected external request');
            },
          },
        },
      },
    ],
  });
  t.after(() => runtime.dispose());
  await migrate(await runtime.getD1Database('DB'));
  const login = await runtime.dispatchFetch('https://app.test/auth/login', { redirect: 'manual' });
  assert.equal(login.status, 302);
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const stateCookie = login.headers.get('Set-Cookie').split(';')[0];
  const callback = await runtime.dispatchFetch(
    'https://app.test/auth/callback?' + new URLSearchParams({ state, code: 'test-code' }),
    {
      redirect: 'manual',
      headers: { Cookie: stateCookie },
    }
  );
  assert.equal(callback.headers.get('Location'), '/');
  assert.equal(tokenRequests, 1);
  const session = callback.headers.getSetCookie().find((value) => value.startsWith('session='));
  assert.ok(session.includes('Secure'));
  const me = await runtime.dispatchFetch('https://app.test/api/me', {
    headers: { Cookie: session.split(';')[0] },
  });
  assert.equal((await me.json()).user.id, 'runtime-user');
  const asset = await runtime.dispatchFetch('https://app.test/styles.css');
  assert.equal(await asset.text(), 'static asset');
  for (const response of [me, asset]) {
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.ok(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  }
});
