import { encrypt, webhookURL } from './security.js';
import { requestJSON } from './providers.js';
import { fail } from './http.js';

export async function verifyDestination(input, env) {
  const url = webhookURL(input);
  let info;
  try {
    info = await requestJSON(url);
    if (!info.channel_id || info.type !== 1) throw new Error();
  } catch {
    throw fail('Discord could not verify that webhook. Check that it is still valid.');
  }
  return {
    encrypted: await encrypt(url, env.ENCRYPTION_KEY),
    destination: `Discord channel …${String(info.channel_id).slice(-6)}`,
  };
}
