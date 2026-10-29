import { hash, random, same } from './security.js';
import { ProviderError, requestJSON } from './providers.js';
import {
  now,
  fail,
  first,
  run,
  statement,
  cookie,
  cookieHeader,
  redirect,
  rateLimit,
} from './http.js';
export async function userFor(request, env) {
  const token = cookie(request, 'session');
  if (!token) return null;
  return first(
    env,
    `SELECT u.id,u.name FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`,
    await hash(token),
    now()
  );
}
export async function auth(request, env, path) {
  if (path === '/auth/login') {
    if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.ENCRYPTION_KEY)
      return redirect('/?error=not-configured');
    await rateLimit(env, 'login:' + (request.headers.get('CF-Connecting-IP') || 'local'), 15);
    const state = random();
    await run(
      env,
      'INSERT INTO oauth_states(token_hash,expires_at) VALUES(?,?)',
      await hash(state),
      now() + 600000
    );
    const query = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      redirect_uri: env.APP_URL + '/auth/callback',
      response_type: 'code',
      scope: 'identify',
      state,
    });
    return redirect('https://discord.com/oauth2/authorize?' + query, [
      cookieHeader(env, 'oauth_state', state, 600),
    ]);
  }
  if (path === '/auth/callback') {
    const url = new URL(request.url),
      state = url.searchParams.get('state'),
      code = url.searchParams.get('code');
    if (!state || !same(state, cookie(request, 'oauth_state')) || !code) {
      console.warn('Discord login failed', {
        stage: 'callback-validation',
        hasState: !!state,
        hasStateCookie: !!cookie(request, 'oauth_state'),
        stateMatches: !!state && same(state, cookie(request, 'oauth_state')),
        hasCode: !!code,
      });
      return redirect('/?error=login');
    }
    const record = await first(
      env,
      'DELETE FROM oauth_states WHERE token_hash=? AND expires_at>? RETURNING token_hash',
      await hash(state),
      now()
    );
    if (!record) {
      console.warn('Discord login failed', { stage: 'state-expired-or-used' });
      return redirect('/?error=login');
    }
    let stage = 'token-exchange';
    try {
      const token = await requestJSON('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: env.APP_URL + '/auth/callback',
        }),
      });
      stage = 'profile-fetch';
      const profile = await requestJSON('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!profile.id) throw fail('Discord profile unavailable.');
      const session = random();
      stage = 'session-save';
      await env.DB.batch([
        statement(
          env,
          'INSERT INTO users(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',
          profile.id,
          profile.global_name || profile.username,
          now()
        ),
        statement(
          env,
          'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',
          await hash(session),
          profile.id,
          now() + 2592000000
        ),
      ]);
      // OAuth access tokens are deliberately not retained; only the user identity is needed.
      return redirect('/', [
        cookieHeader(env, 'session', session, 2592000),
        cookieHeader(env, 'oauth_state', '', 0),
      ]);
    } catch (error) {
      console.error('Discord login failed', {
        stage,
        errorType: error?.name || 'Error',
        status: error instanceof ProviderError ? error.status : undefined,
      });
      return redirect('/?error=login', [cookieHeader(env, 'oauth_state', '', 0)]);
    }
  }
  throw fail('Not found.', 404);
}
