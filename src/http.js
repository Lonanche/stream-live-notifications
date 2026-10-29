export const now = () => Date.now();
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const statement = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export const first = (env, sql, ...args) => statement(env, sql, ...args).first();
export const all = async (env, sql, ...args) => (await statement(env, sql, ...args).all()).results;
export const run = (env, sql, ...args) => statement(env, sql, ...args).run();
export const cookie = (request, name) =>
  request.headers
    .get('Cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + '='))
    ?.slice(name.length + 1);
export function cookieHeader(env, name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(env.APP_URL).protocol === 'https:' ? '; Secure' : ''}`;
}
export function redirect(path, cookies = []) {
  const headers = new Headers({ Location: path, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}
export async function bodyJSON(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw fail('Expected JSON.', 415);
  const body = await limitedBody(request);
  try {
    const value = JSON.parse(body);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw fail('Invalid JSON.');
  }
}
export async function limitedBody(request, limit = 16384) {
  if (Number(request.headers.get('Content-Length') || 0) > limit)
    throw fail('Request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) return '';
  const parts = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw fail('Request is too large.', 413);
    }
    parts.push(value);
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(buffer);
}
export async function rateLimit(env, key, limit, period = 60000) {
  const bucket = Math.floor(now() / period);
  const row = await first(
    env,
    `INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`,
    `${key}:${bucket}`,
    (bucket + 2) * period
  );
  if (row.count > limit) throw fail('Too many requests. Please try again shortly.', 429);
}
