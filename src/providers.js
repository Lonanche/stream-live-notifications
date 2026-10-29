import { bytes, unb64 } from './security.js';
const tokens = new Map();
let kickKey;
export class ProviderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}
export async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw new ProviderError(`External service returned HTTP ${response.status}.`, response.status);
  return response.json();
}
export async function appToken(platform, env, refresh = false) {
  const prefix = platform.toUpperCase();
  if (!env[`${prefix}_CLIENT_ID`] || !env[`${prefix}_CLIENT_SECRET`])
    throw new ProviderError(
      `${platform === 'kick' ? 'Kick' : 'Twitch'} has not been configured by the site owner.`,
      503
    );
  const cacheKey = platform + ':' + env[`${prefix}_CLIENT_ID`];
  const cached = tokens.get(cacheKey);
  if (!refresh && cached && cached.expires > Date.now()) return cached.value;
  const result = await requestJSON(
    platform === 'twitch' ? 'https://id.twitch.tv/oauth2/token' : 'https://id.kick.com/oauth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env[`${prefix}_CLIENT_ID`],
        client_secret: env[`${prefix}_CLIENT_SECRET`],
        grant_type: 'client_credentials',
      }),
    }
  );
  if (!result.access_token) throw new ProviderError('Provider did not return an access token.');
  tokens.set(cacheKey, {
    value: result.access_token,
    expires: Date.now() + Math.max(0, Number(result.expires_in || 300) - 60) * 1000,
  });
  return result.access_token;
}
export async function api(platform, path, env, options = {}, retry = true) {
  const token = await appToken(platform, env);
  try {
    return await requestJSON(
      (platform === 'twitch' ? 'https://api.twitch.tv/helix/' : 'https://api.kick.com/public/v1/') +
        path,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(platform === 'twitch' ? { 'Client-Id': env.TWITCH_CLIENT_ID } : {}),
          ...options.headers,
        },
      }
    );
  } catch (error) {
    if (retry && error.status === 401) {
      await appToken(platform, env, true);
      return api(platform, path, env, options, false);
    }
    throw error;
  }
}
export function kickChannel(c) {
  return {
    platform: 'kick',
    broadcaster_id: String(c.broadcaster_user_id),
    slug: c.slug,
    live: Boolean(c.stream?.is_live),
    stream_key: c.stream?.is_live ? normalizedTime(c.stream.start_time) : null,
    title: c.stream_title || '',
    game: c.category?.name || '',
  };
}
export function normalizedTime(time) {
  const n = Date.parse(time);
  if (!Number.isFinite(n) || n < 1000000000000)
    throw new ProviderError('Provider returned an invalid stream start time.');
  return new Date(n).toISOString();
}
export async function resolveChannel(platform, slug, env) {
  if (platform === 'kick') {
    const result = await api('kick', 'channels?' + new URLSearchParams({ slug }), env);
    const channel = result.data?.find((c) => c.slug.toLowerCase() === slug);
    if (!channel) throw new ProviderError('That Kick channel was not found.', 404);
    return kickChannel(channel);
  }
  const result = await api('twitch', 'users?' + new URLSearchParams({ login: slug }), env);
  const user = result.data?.[0];
  if (!user) throw new ProviderError('That Twitch channel was not found.', 404);
  const stream = (await api('twitch', 'streams?' + new URLSearchParams({ user_id: user.id }), env))
    .data?.[0];
  return {
    platform: 'twitch',
    broadcaster_id: user.id,
    slug: user.login,
    live: !!stream,
    stream_key: stream ? normalizedTime(stream.started_at) : null,
    title: stream?.title || '',
    game: stream?.game_name || '',
  };
}
export async function pollChannels(platform, channels, env) {
  const query = new URLSearchParams();
  for (const c of channels)
    query.append(platform === 'twitch' ? 'user_id' : 'broadcaster_user_id', c.broadcaster_id);
  if (platform === 'twitch') query.set('first', '100');
  const result = await api(
    platform,
    (platform === 'twitch' ? 'streams?' : 'channels?') + query,
    env
  );
  if (!Array.isArray(result.data))
    throw new ProviderError('Provider returned an invalid channel response.');
  if (platform === 'kick') {
    // Missing channels are not evidence that a stream ended.
    return result.data.map(kickChannel);
  }
  const streams = new Map(result.data.map((s) => [String(s.user_id), s]));
  return channels.map((c) => {
    const s = streams.get(c.broadcaster_id);
    return {
      ...c,
      live: !!s,
      stream_key: s ? normalizedTime(s.started_at) : null,
      title: s?.title || c.title,
      game: s ? s.game_name || '' : c.game || '',
    };
  });
}
export async function ensureSubscription(channel, env) {
  const { platform, broadcaster_id } = channel;
  if (platform === 'twitch') {
    if (!env.TWITCH_WEBHOOK_SECRET)
      throw new ProviderError('Twitch webhook secret is missing.', 503);
    try {
      const result = await api('twitch', 'eventsub/subscriptions', env, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'stream.online',
          version: '1',
          condition: { broadcaster_user_id: broadcaster_id },
          transport: {
            method: 'webhook',
            callback: env.APP_URL + '/hooks/twitch',
            secret: env.TWITCH_WEBHOOK_SECRET,
          },
        }),
      });
      return { id: result.data?.[0]?.id || null, status: result.data?.[0]?.status || 'pending' };
    } catch (error) {
      if (error.status === 409) return { id: channel.subscription_id || null, status: 'enabled' };
      throw error;
    }
  }
  const existing = await api(
    'kick',
    'events/subscriptions?' + new URLSearchParams({ broadcaster_user_id: broadcaster_id }),
    env
  );
  const match = existing.data?.find(
    (s) => s.event === 'livestream.status.updated' && s.version === 1
  );
  if (match) return { id: match.id, status: 'enabled' };
  const result = await api('kick', 'events/subscriptions', env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      broadcaster_user_id: Number(broadcaster_id),
      events: [{ name: 'livestream.status.updated', version: 1 }],
      method: 'webhook',
    }),
  });
  const sub = result.data?.[0];
  if (!sub?.subscription_id || sub.error)
    throw new ProviderError(
      'Kick did not accept the event subscription. Check the app webhook settings.'
    );
  return { id: sub.subscription_id, status: 'enabled' };
}
export async function removeSubscription(channel, env) {
  if (!channel.subscription_id) return;
  const token = await appToken(channel.platform, env);
  const platform = channel.platform;
  const url =
    (platform === 'twitch'
      ? 'https://api.twitch.tv/helix/eventsub/subscriptions?'
      : 'https://api.kick.com/public/v1/events/subscriptions?') +
    new URLSearchParams({ id: channel.subscription_id });
  const r = await fetch(url, {
    method: 'DELETE',
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(platform === 'twitch' ? { 'Client-Id': env.TWITCH_CLIENT_ID } : {}),
    },
  });
  if (!r.ok && r.status !== 404)
    throw new ProviderError(`Could not remove subscription (HTTP ${r.status}).`);
}
async function fetchKickKey() {
  const result = await requestJSON('https://api.kick.com/public/v1/public-key');
  const pem = result.data?.public_key;
  if (!pem) throw new ProviderError('Kick public key is unavailable.');
  const der = unb64(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));
  kickKey = {
    key: await crypto.subtle.importKey(
      'spki',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    ),
    expires: Date.now() + 3600000,
  };
  return kickKey.key;
}
export async function verifyKick(request, body, now = Date.now()) {
  const id = request.headers.get('Kick-Event-Message-Id'),
    time = request.headers.get('Kick-Event-Message-Timestamp'),
    sig = request.headers.get('Kick-Event-Signature');
  if (
    !id ||
    !time ||
    !sig ||
    !Number.isFinite(Date.parse(time)) ||
    Math.abs(now - Date.parse(time)) > 600000
  )
    return false;
  let signature;
  try {
    signature = unb64(sig);
  } catch {
    return false;
  }
  const key = kickKey && kickKey.expires > Date.now() ? kickKey.key : await fetchKickKey();
  if (
    await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, bytes(`${id}.${time}.${body}`))
  )
    return true;
  // Refresh immediately on verification failure to tolerate key rotation.
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    await fetchKickKey(),
    signature,
    bytes(`${id}.${time}.${body}`)
  );
}
