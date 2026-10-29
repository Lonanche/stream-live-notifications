const $ = (s) => document.querySelector(s);
let user = null,
  rules = [],
  editing = null,
  toastTimer,
  platforms = {};
const form = $('#alert-form');
async function api(path, options = {}) {
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 5000);
}
function node(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function action(label, name, id, cls = '') {
  const b = node('button', 'button subtle ' + cls, label);
  b.type = 'button';
  b.dataset.action = name;
  b.dataset.id = id;
  return b;
}
function preview() {
  const platform = form.elements.platform.value,
    raw = form.elements.channel.value.trim();
  let channel =
    raw.replace(/^https?:\/\/(www\.)?(twitch\.tv|kick\.com)\//i, '').replace(/\/$/, '') ||
    'yourchannel';
  if (!/^[a-z0-9_-]{1,50}$/i.test(channel)) channel = 'yourchannel';
  const label = platform === 'twitch' ? 'Twitch' : 'Kick',
    url = `https://${platform === 'twitch' ? 'twitch.tv' : 'kick.com'}/${channel}`,
    values = { channel, platform: label, url, title: 'Your next great stream', game: 'Rust' };
  $('#preview-content').textContent = form.elements.message.value
    .replace(/\{(channel|platform|url|title|game)\}/g, (_, k) => values[k])
    .slice(0, 2000);
}
function renderRules() {
  const container = $('#rules');
  container.replaceChildren();
  $('#alert-count').textContent = rules.length;
  if (!rules.length) {
    container.append(
      node(
        'div',
        'empty',
        'Your first alert starts here. Choose a channel above, then create your alert.'
      )
    );
    return;
  }
  for (const r of rules) {
    const card = node('article', 'rule'),
      top = node('div', 'rule-top');
    top.append(
      node('div', 'rule-name ' + r.platform, (r.platform === 'twitch' ? '▣ ' : 'K ') + r.slug),
      node(
        'span',
        'rule-status ' + (r.enabled && r.live ? 'live' : ''),
        !r.enabled ? 'Paused' : r.live ? '● Live' : 'Watching'
      )
    );
    card.append(
      top,
      node(
        'div',
        'rule-meta',
        r.destination + ' · ' + (r.platform === 'twitch' ? 'Twitch' : 'Kick')
      ),
      node('p', 'rule-message', r.message)
    );
    if (r.game) card.append(node('p', 'field-help', 'Game / category: ' + r.game));
    const status = node(
      'p',
      'field-help',
      r.enabled
        ? r.subscription_status === 'enabled'
          ? 'Webhook connected · Scheduled backup checks enabled'
          : r.subscription_status === 'pending'
            ? 'Connecting webhook · Scheduled checks enabled'
            : 'Scheduled checks enabled · Webhook: ' + r.subscription_status
        : 'Notifications paused'
    );
    if (r.error) status.append(node('span', 'error', ' · ' + r.error));
    card.append(status);
    const buttons = node('div', 'rule-actions');
    buttons.append(
      action('Send test', 'test', r.id),
      action('Edit', 'edit', r.id),
      action(r.enabled ? 'Pause' : 'Resume', 'toggle', r.id),
      action('Delete', 'delete', r.id, 'danger')
    );
    card.append(buttons);
    if (r.checked_at)
      card.append(
        node('p', 'field-help', 'Last checked ' + new Date(r.checked_at).toLocaleString())
      );
    container.append(card);
  }
}
function renderHistory(history) {
  const container = $('#history');
  container.replaceChildren();
  if (!history.length) {
    container.append(
      node('div', 'empty', 'Nothing sent yet. Send a test, or wait for the next stream to begin.')
    );
    return;
  }
  for (const i of history) {
    const row = node('div', 'delivery'),
      label = node('div', '', i.slug + ' · ' + (i.platform === 'twitch' ? 'Twitch' : 'Kick'));
    label.append(
      node('small', '', new Date(i.created_at).toLocaleString() + (i.error ? ' · ' + i.error : ''))
    );
    row.append(
      label,
      node(
        'span',
        'state ' + i.state,
        i.state === 'sending'
          ? 'Sending'
          : i.state === 'pending'
            ? 'Queued'
            : i.state[0].toUpperCase() + i.state.slice(1)
      )
    );
    container.append(row);
  }
}
async function refresh() {
  const data = await api('/api/rules');
  rules = data.rules;
  renderRules();
  renderHistory(data.history);
}
function resetForm() {
  editing = null;
  form.reset();
  form.elements.channel.disabled = false;
  for (const e of form.querySelectorAll('[name=platform]')) e.disabled = !platforms[e.value];
  if (!platforms.twitch && platforms.kick) form.elements.platform.value = 'kick';
  form.elements.webhook.required = true;
  $('#form-title').textContent = 'Create an alert';
  $('#submit').textContent = 'Create alert ↗';
  $('#cancel-edit').hidden = true;
  $('#webhook-optional').hidden = true;
  $('#form-error').hidden = true;
  preview();
}
form.addEventListener('input', preview);
form.addEventListener('click', (event) => {
  const t = event.target.closest('[data-token]');
  if (!t) return;
  const input = form.elements.message;
  input.setRangeText(t.dataset.token, input.selectionStart, input.selectionEnd, 'end');
  input.focus();
  preview();
});
$('#cancel-edit').addEventListener('click', resetForm);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!user) return;
  const b = $('#submit');
  b.disabled = true;
  $('#form-error').hidden = true;
  try {
    const body = { message: form.elements.message.value, webhook: form.elements.webhook.value };
    if (!editing) {
      body.platform = form.elements.platform.value;
      body.channel = form.elements.channel.value;
    }
    await api(editing ? '/api/rules/' + editing : '/api/rules', {
      method: editing ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
    });
    const changed = !!editing;
    resetForm();
    await refresh();
    toast(changed ? 'Alert updated.' : 'Alert created. We’ll announce the next broadcast.');
  } catch (e) {
    $('#form-error').textContent = e.message;
    $('#form-error').hidden = false;
  } finally {
    b.disabled = false;
  }
});
$('#rules').addEventListener('click', async (event) => {
  const b = event.target.closest('[data-action]');
  if (!b) return;
  const r = rules.find((r) => r.id === b.dataset.id);
  if (!r) return;
  const a = b.dataset.action;
  if (a === 'edit') {
    resetForm();
    editing = r.id;
    form.elements.platform.value = r.platform;
    form.elements.channel.value = r.slug;
    form.elements.message.value = r.message;
    form.elements.channel.disabled = true;
    for (const e of form.querySelectorAll('[name=platform]')) e.disabled = true;
    form.elements.webhook.required = false;
    $('#form-title').textContent = 'Edit ' + r.slug;
    $('#submit').textContent = 'Save changes ↗';
    $('#cancel-edit').hidden = false;
    $('#webhook-optional').hidden = false;
    preview();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (a === 'delete' && !window.confirm(`Delete the ${r.slug} alert?`)) return;
  b.disabled = true;
  try {
    if (a === 'test') {
      await api('/api/rules/' + r.id + '/test', { method: 'POST' });
      toast('Test queued. Check Discord and delivery history.');
    }
    if (a === 'toggle') {
      await api('/api/rules/' + r.id, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      toast(r.enabled ? 'Alert paused.' : 'Alert resumed for the next broadcast.');
    }
    if (a === 'delete') {
      await api('/api/rules/' + r.id, { method: 'DELETE' });
      if (editing === r.id) resetForm();
      toast('Alert deleted.');
    }
    await refresh();
  } catch (e) {
    toast(e.message);
  } finally {
    b.disabled = false;
  }
});
$('#refresh').addEventListener('click', async () => {
  const b = $('#refresh');
  b.disabled = true;
  try {
    await refresh();
  } catch (e) {
    toast(e.message);
  } finally {
    b.disabled = false;
  }
});
async function start() {
  preview();
  const error = new URLSearchParams(location.search).get('error');
  if (error) {
    $('#notice').textContent =
      error === 'not-configured'
        ? 'The site owner needs to finish Discord sign-in and encryption setup.'
        : 'Discord sign-in did not finish. Please try connecting again.';
    $('#notice').hidden = false;
    history.replaceState({}, '', '/');
  }
  try {
    const data = await api('/api/me');
    user = data.user;
    platforms = data.platforms;
    if (!data.ready) {
      $('#notice').textContent =
        'This installation is awaiting setup. The site owner needs to configure Discord sign-in and the encryption key.';
      $('#notice').hidden = false;
    }
    $('#signin-banner').hidden = !!user;
    $('#hero').hidden = !!user;
    if (!user) return;
    $('#form-fields').disabled = false;
    $('#alerts-section').hidden = false;
    $('#history-section').hidden = false;
    const account = $('#account');
    account.replaceChildren(node('span', 'user-name', user.name));
    const logout = node('button', 'button subtle', 'Sign out');
    logout.type = 'button';
    logout.addEventListener('click', async () => {
      try {
        await api('/api/logout', { method: 'POST' });
        location.reload();
      } catch (e) {
        toast(e.message);
      }
    });
    account.append(logout);
    resetForm();
    if (!platforms.twitch && !platforms.kick) {
      $('#form-fields').disabled = true;
      toast('The site owner has not configured a streaming platform yet.');
    }
    await refresh();
    setInterval(() => {
      if (!document.hidden) refresh().catch(() => {});
    }, 30000);
  } catch (e) {
    $('#notice').textContent = 'Could not load the dashboard: ' + e.message;
    $('#notice').hidden = false;
  }
}
start();
