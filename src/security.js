const encoder = new TextEncoder();
export const bytes = (s) => encoder.encode(s);
export const b64 = (v) => btoa(String.fromCharCode(...v));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const random = () =>
  b64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
export const hash = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(s)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function encrypt(value, secret) {
  const key = await crypto.subtle.importKey('raw', unb64(secret), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes(value))
  );
  return `v1.${b64(iv)}.${b64(ciphertext)}`;
}
export async function decrypt(value, secret) {
  const [version, iv, ciphertext] = value.split('.');
  if (version !== 'v1') throw new Error('Invalid encrypted value');
  const key = await crypto.subtle.importKey('raw', unb64(secret), 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ciphertext))
  );
}
export function webhookURL(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error('Enter a valid Discord webhook URL.');
  }
  if (
    u.protocol !== 'https:' ||
    u.hostname !== 'discord.com' ||
    u.port ||
    u.username ||
    u.password ||
    !/^\/api(?:\/v\d+)?\/webhooks\/\d{17,22}\/[A-Za-z0-9_-]{40,150}$/.test(u.pathname) ||
    u.search ||
    u.hash
  )
    throw new Error('Use a Discord webhook URL copied from Channel Settings → Integrations.');
  return u.href;
}
export function channelSlug(platform, input) {
  if (!['twitch', 'kick'].includes(platform)) throw new Error('Choose Twitch or Kick.');
  let slug = String(input || '')
    .trim()
    .toLowerCase();
  if (/^https?:/i.test(slug)) {
    const u = new URL(slug);
    if (
      ![`${platform}.tv`, `www.${platform}.tv`, 'kick.com', 'www.kick.com'].includes(u.hostname) ||
      (platform === 'kick'
        ? !/^(www\.)?kick\.com$/.test(u.hostname)
        : !/^(www\.)?twitch\.tv$/.test(u.hostname))
    )
      throw new Error('The channel URL must match the selected platform.');
    slug = u.pathname.replace(/^\/|\/$/g, '');
  }
  if (!/^[a-z0-9_][a-z0-9_-]{0,49}$/.test(slug))
    throw new Error('Enter a channel name or channel URL.');
  return slug;
}
export function messageTemplate(input) {
  const value = String(input ?? '').trim();
  if (!value || value.length > 1200)
    throw new Error('The message must be between 1 and 1,200 characters.');
  return value;
}
export function discordPayload(rule, channel, stream) {
  const url = `https://${channel.platform === 'twitch' ? 'twitch.tv' : 'kick.com'}/${channel.slug}`;
  const values = {
    channel: channel.slug,
    platform: channel.platform === 'twitch' ? 'Twitch' : 'Kick',
    url,
    title: stream.title || 'Live stream',
    game: stream.game || 'Not specified',
  };
  const content = rule.message
    .replace(/\{(channel|platform|url|title|game)\}/g, (_, k) => values[k])
    .slice(0, 2000);
  return {
    username: 'Stream Live Notifications',
    content,
    allowed_mentions: { parse: rule.message.includes('@everyone') ? ['everyone'] : [] },
  };
}
export async function verifyTwitch(request, body, secret, now = Date.now()) {
  const id = request.headers.get('Twitch-Eventsub-Message-Id'),
    time = request.headers.get('Twitch-Eventsub-Message-Timestamp');
  const signature = request.headers.get('Twitch-Eventsub-Message-Signature');
  if (
    !id ||
    !time ||
    !secret ||
    !Number.isFinite(Date.parse(time)) ||
    Math.abs(now - Date.parse(time)) > 600000
  )
    return false;
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(id + time + body)));
  return same(signature, 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join(''));
}
