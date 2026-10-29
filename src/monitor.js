import { random, decrypt, webhookURL, discordPayload, verifyTwitch } from './security.js';
import {
  pollChannels,
  ensureSubscription,
  removeSubscription,
  verifyKick,
  normalizedTime,
  ProviderError,
} from './providers.js';
import { now, fail, statement, first, all, run, limitedBody } from './http.js';
export async function observe(env, channel, stream) {
  // One durable outbox entry per rule and broadcast, regardless of repeated or concurrent notifications.
  // activated_at also prevents announcements for streams already live when a rule is added/resumed.
  if (stream.live && stream.stream_key) {
    const started = Date.parse(stream.stream_key);
    const rules = await all(
      env,
      'SELECT id,message FROM rules WHERE platform=? AND broadcaster_id=? AND enabled=1 AND activated_at<=?',
      channel.platform,
      channel.broadcaster_id,
      started
    );
    for (let offset = 0; offset < rules.length; offset += 50) {
      await env.DB.batch(
        rules
          .slice(offset, offset + 50)
          .map((rule) =>
            statement(
              env,
              `INSERT OR IGNORE INTO deliveries(id,rule_id,stream_key,payload,due_at,created_at) VALUES(?,?,?,?,?,?)`,
              crypto.randomUUID(),
              rule.id,
              stream.stream_key,
              JSON.stringify(discordPayload(rule, channel, stream)),
              now(),
              now()
            )
          )
      );
    }
  }
  await run(
    env,
    'UPDATE channels SET live=?,stream_key=?,title=?,game=?,checked_at=?,error=NULL WHERE platform=? AND broadcaster_id=?',
    stream.live ? 1 : 0,
    stream.stream_key || null,
    stream.title || '',
    stream.game || '',
    now(),
    channel.platform,
    channel.broadcaster_id
  );
}
export async function hooks(request, env, path, ctx) {
  const raw = await limitedBody(request, 131072);
  const platform = path === '/hooks/twitch' ? 'twitch' : path === '/hooks/kick' ? 'kick' : null;
  if (!platform) throw fail('Not found.', 404);
  if (
    !(platform === 'twitch'
      ? await verifyTwitch(request, raw, env.TWITCH_WEBHOOK_SECRET)
      : await verifyKick(request, raw))
  )
    throw fail('Invalid webhook signature.', 403);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw fail('Invalid JSON.');
  }
  if (platform === 'twitch') {
    const sub = payload.subscription;
    if (sub?.type !== 'stream.online' || sub?.version !== '1')
      return new Response(null, { status: 204 });
    const channel = await first(
      env,
      'SELECT * FROM channels WHERE platform=? AND broadcaster_id=?',
      'twitch',
      String(sub.condition?.broadcaster_user_id || '')
    );
    if (!channel) return new Response(null, { status: 204 });
    const type = request.headers.get('Twitch-Eventsub-Message-Type');
    if (type === 'webhook_callback_verification') {
      if (typeof payload.challenge !== 'string') throw fail('Missing challenge.');
      await run(
        env,
        'UPDATE channels SET subscription_id=?,subscription_status=? WHERE platform=? AND broadcaster_id=?',
        sub.id,
        'enabled',
        'twitch',
        channel.broadcaster_id
      );
      return new Response(payload.challenge, { headers: { 'Content-Type': 'text/plain' } });
    }
    if (type === 'revocation') {
      await run(
        env,
        'UPDATE channels SET subscription_id=NULL,subscription_status=?,subscription_checked_at=0 WHERE platform=? AND broadcaster_id=?',
        'revoked',
        'twitch',
        channel.broadcaster_id
      );
    } else if (
      type === 'notification' &&
      String(payload.event?.broadcaster_user_id) === channel.broadcaster_id
    ) {
      const fresh = (await pollChannels('twitch', [channel], env))[0];
      if (fresh?.live) await observe(env, fresh, fresh);
    }
  } else if (
    request.headers.get('Kick-Event-Type') === 'livestream.status.updated' &&
    request.headers.get('Kick-Event-Version') === '1'
  ) {
    const channel = await first(
      env,
      'SELECT * FROM channels WHERE platform=? AND broadcaster_id=?',
      'kick',
      String(payload.broadcaster?.user_id || '')
    );
    console.info('Kick status event received', {
      broadcasterId: String(payload.broadcaster?.user_id || ''),
      channelFound: !!channel,
      live: payload.is_live === true,
    });
    if (channel && payload.is_live === true) {
      // Kick's status event has a title but no category; fetch current channel metadata.
      let fresh;
      try {
        fresh = (await pollChannels('kick', [channel], env))[0];
      } catch (error) {
        console.warn('Kick live metadata lookup failed', {
          broadcasterId: channel.broadcaster_id,
          errorType: error?.name,
          status: error instanceof ProviderError ? error.status : undefined,
          reason: error instanceof ProviderError ? error.message : undefined,
        });
      }
      await observe(env, channel, {
        live: true,
        stream_key: normalizedTime(payload.started_at),
        title: payload.title || '',
        game: fresh?.game ?? channel.game ?? '',
      });
    }
    if (channel && payload.is_live === false)
      await observe(env, channel, {
        live: false,
        stream_key: null,
        title: payload.title || '',
        game: channel.game,
      });
  }
  ctx.waitUntil(drain(env, 2));
  return new Response(null, { status: 204 });
}
export async function drain(env, limit = 10) {
  const due = await all(
    env,
    `SELECT id FROM deliveries WHERE state IN ('pending','sending') AND due_at<=? ORDER BY due_at LIMIT ?`,
    now(),
    limit
  );
  for (const item of due) {
    const claimUntil = now() + 120000;
    const d = await first(
      env,
      `UPDATE deliveries SET state='sending',attempts=attempts+1,due_at=? WHERE id=? AND state IN ('pending','sending') AND due_at<=? RETURNING *`,
      claimUntil,
      item.id,
      now()
    );
    if (!d) continue;
    const rule = await first(env, 'SELECT webhook,enabled FROM rules WHERE id=?', d.rule_id);
    if (
      !rule ||
      (!rule.enabled && !d.stream_key.startsWith('test:')) ||
      d.created_at < now() - 21600000
    ) {
      await run(
        env,
        "UPDATE deliveries SET state='cancelled',error=? WHERE id=? AND state='sending' AND due_at=?",
        rule?.enabled ? 'Notification expired.' : 'Alert paused or deleted.',
        d.id,
        claimUntil
      );
      continue;
    }
    let error = 'Discord could not be reached.',
      permanent = false,
      retryAfter = 0;
    try {
      const url = new URL(webhookURL(await decrypt(rule.webhook, env.ENCRYPTION_KEY)));
      url.searchParams.set('wait', 'true');
      // Older queued deliveries may still contain the former custom embed.
      const payload = JSON.parse(d.payload);
      delete payload.embeds;
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        await response.arrayBuffer();
        await run(
          env,
          "UPDATE deliveries SET state='sent',sent_at=?,error=NULL WHERE id=? AND state='sending' AND due_at=?",
          now(),
          d.id,
          claimUntil
        );
        continue;
      }
      error = `Discord returned HTTP ${response.status}.`;
      permanent = [400, 401, 403, 404].includes(response.status);
      if (response.status === 429) {
        const detail = await response.json().catch(() => ({}));
        retryAfter = Math.min(3600000, Math.max(0, Number(detail.retry_after) || 0) * 1000);
      } else await response.arrayBuffer();
    } catch {
      /* Never persist raw errors: they can contain webhook tokens. */
    }
    await run(
      env,
      `UPDATE deliveries SET state=?,error=?,due_at=? WHERE id=? AND state='sending' AND due_at=?`,
      permanent || d.attempts >= 8 ? 'failed' : 'pending',
      error,
      now() + Math.max(retryAfter, Math.min(1800000, 15000 * 2 ** d.attempts)),
      d.id,
      claimUntil
    );
  }
}
export async function synchronizeSubscription(env, c) {
  try {
    const current =
      (await first(
        env,
        'SELECT * FROM channels WHERE platform=? AND broadcaster_id=?',
        c.platform,
        c.broadcaster_id
      )) || c;
    const subscription = await ensureSubscription(current, env);
    await run(
      env,
      'UPDATE channels SET subscription_id=COALESCE(?,subscription_id),subscription_status=?,subscription_checked_at=? WHERE platform=? AND broadcaster_id=?',
      subscription.id,
      subscription.status,
      now(),
      c.platform,
      c.broadcaster_id
    );
  } catch (error) {
    console.warn('Provider subscription failed', {
      platform: c.platform,
      broadcasterId: c.broadcaster_id,
      errorType: error?.name,
      status: error instanceof ProviderError ? error.status : undefined,
      reason: error instanceof ProviderError ? error.message : undefined,
    });
    await run(
      env,
      "UPDATE channels SET subscription_status='polling fallback',subscription_checked_at=? WHERE platform=? AND broadcaster_id=?",
      now() - 18000000,
      c.platform,
      c.broadcaster_id
    );
  }
}
export async function scheduled(env) {
  const lease = random();
  const acquired = await first(
    env,
    `INSERT INTO leases(name,token,expires_at) VALUES('monitor',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE leases.expires_at<? RETURNING token`,
    lease,
    now() + 300000,
    now()
  );
  if (!acquired) return;
  try {
    // Rotate fairly through monitored channels. Batches are bounded for Worker/API limits.
    const channels = await all(
      env,
      `SELECT c.* FROM channels c WHERE EXISTS(SELECT 1 FROM rules r WHERE r.platform=c.platform AND r.broadcaster_id=c.broadcaster_id AND r.enabled=1) ORDER BY checked_at LIMIT 50`
    );
    for (const platform of ['twitch', 'kick']) {
      const group = channels.filter((c) => c.platform === platform);
      if (!group.length) continue;
      try {
        const fresh = await pollChannels(platform, group, env);
        for (const c of fresh) await observe(env, c, c);
        const seen = new Set(fresh.map((c) => c.broadcaster_id));
        for (const c of group.filter((c) => !seen.has(c.broadcaster_id)))
          await run(
            env,
            'UPDATE channels SET checked_at=?,error=? WHERE platform=? AND broadcaster_id=?',
            now(),
            'Channel was absent from the provider response.',
            platform,
            c.broadcaster_id
          );
      } catch (error) {
        console.warn('Provider backup check failed', {
          platform,
          errorType: error?.name,
          status: error instanceof ProviderError ? error.status : undefined,
          reason: error instanceof ProviderError ? error.message : undefined,
        });
        for (const c of group)
          await run(
            env,
            'UPDATE channels SET checked_at=?,error=? WHERE platform=? AND broadcaster_id=?',
            now(),
            'Channel check failed. Will retry automatically.',
            platform,
            c.broadcaster_id
          );
      }
    }
    const repair = await all(
      env,
      `SELECT c.* FROM channels c WHERE subscription_checked_at<? AND EXISTS(SELECT 1 FROM rules r WHERE r.platform=c.platform AND r.broadcaster_id=c.broadcaster_id AND r.enabled=1) ORDER BY subscription_checked_at LIMIT 3`,
      now() - 21600000
    );
    for (const c of repair) await synchronizeSubscription(env, c);
    const unused = await all(
      env,
      `SELECT c.* FROM channels c WHERE subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rules r WHERE r.platform=c.platform AND r.broadcaster_id=c.broadcaster_id AND r.enabled=1) LIMIT 2`
    );
    for (const c of unused) {
      try {
        await removeSubscription(c, env);
        await run(
          env,
          "UPDATE channels SET subscription_id=NULL,subscription_status='paused',subscription_checked_at=0 WHERE platform=? AND broadcaster_id=?",
          c.platform,
          c.broadcaster_id
        );
      } catch {
        /* Retry next tick. */
      }
    }
    await drain(env, 10);
    await env.DB.batch([
      statement(env, 'DELETE FROM sessions WHERE expires_at<?', now()),
      statement(env, 'DELETE FROM oauth_states WHERE expires_at<?', now()),
      statement(env, 'DELETE FROM rate_limits WHERE expires_at<?', now()),
      // Retain broadcast deduplication keys while the corresponding rule exists.
      statement(
        env,
        "UPDATE deliveries SET payload='{}' WHERE state IN ('sent','failed','cancelled') AND created_at<? AND payload!='{}'",
        now() - 2592000000
      ),
    ]);
  } finally {
    await run(env, "DELETE FROM leases WHERE name='monitor' AND token=?", lease);
  }
}
