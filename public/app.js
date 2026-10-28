'use strict';
const $ = (s, el = document) => el.querySelector(s);
const AGENTS = { claude: { label: 'Claude Code', letter: 'C' }, codex: { label: 'Codex', letter: 'X' } };
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } };

const state = {
  tasks: [], sel: null, status: null,
  agents: new Set(store('agents') || ['claude', 'codex']),
  mode: store('mode') || 'build',
  kind: store('kind') || 'compete',
  models: store('models') || { claude: '', codex: '' },
  tab: {}, // `${taskId}:${agent}` -> 'activity' | 'changes'
};
const isMac = /Mac|iPhone/.test(navigator.platform);
$('#runKbd').textContent = isMac ? '⌘ ↵' : 'Ctrl ↵';
$('#palKbd').textContent = isMac ? '⌘ K' : 'Ctrl K';
$('#palHint').onclick = () => openPalette();

// ---------- utils ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(path, opts = {}) {
  const r = await fetch(path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { code: j.code });
  return j;
}
function toast(msg, err, href) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  if (href) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' Open'; t.append(a); }
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}
function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
function dur(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; }
const kfmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));

// Tiny markdown: fences, inline code, bold, paragraphs. Everything is escaped first.
function md(text) {
  const parts = String(text).split(/```/);
  return parts.map((p, i) => {
    if (i % 2) return `<pre><code>${esc(p.replace(/^[^\n]*\n/, ''))}</code></pre>`;
    return p.split(/\n{2,}/).filter((x) => x.trim()).map((para) =>
      `<p>${esc(para).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</p>`).join('');
  }).join('');
}

// ---------- accounts ----------
async function loadStatus() {
  try { state.status = await api('/api/status'); } catch { return; }
  const box = $('#accounts');
  box.innerHTML = '';
  for (const [id, a] of Object.entries(AGENTS)) {
    const s = state.status[id];
    const el = document.createElement('div');
    el.className = `acct ${id} ${s.loggedIn ? (s.warning ? 'warn' : 'ok') : ''}`;
    const sub = !s.installed ? s.detail + ' - install it first' : s.detail;
    el.innerHTML = `<span class="dot"></span><div style="min-width:0"><div class="name"><b>${a.label}</b></div><div class="sub" title="${esc(sub)}">${esc(sub)}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'mini' + (s.loggedIn ? '' : ' primary');
    btn.textContent = s.loggedIn ? 'Sign out' : 'Sign in';
    btn.disabled = !s.installed;
    btn.onclick = async () => {
      if (s.loggedIn) { await api(`/api/login/${id}/logout`, { method: 'POST' }); return loadStatus(); }
      await api(`/api/login/${id}`, { method: 'POST' });
      toast(`Finish signing in to ${a.label} in the browser window that opened.`);
      let n = 0; const iv = setInterval(async () => { await loadStatus(); if (state.status[id].loggedIn || ++n > 40) clearInterval(iv); }, 3000);
    };
    el.append(btn);
    if (s.warning) el.insertAdjacentHTML('beforeend', `<div class="warnline">${esc(s.warning)}</div>`);
    box.append(el);
  }
  const g = state.status.github || {};
  const gc = document.createElement('div');
  gc.className = `acct github ${g.loggedIn ? 'ok' : ''}`;
  const gsub = !g.installed ? 'GitHub CLI not found' : g.loggedIn ? `@${g.user}` : 'Not connected';
  gc.innerHTML = `<span class="dot"></span><div style="min-width:0"><div class="name"><b>GitHub</b></div><div class="sub" title="${esc(gsub)}">${esc(gsub)}</div></div>`;
  const gb = document.createElement('button');
  gb.className = 'mini' + (g.loggedIn ? '' : ' primary');
  gb.textContent = g.loggedIn ? 'Projects' : g.installed ? 'Connect' : 'Install';
  gb.onclick = () => { if (g.loggedIn) openProj('github'); else if (g.installed) connectGithub(); else githubInstallHelp(); };
  gc.append(gb);
  if (!g.installed) gc.insertAdjacentHTML('beforeend', '<div class="warnline" style="color:var(--muted)">Run <code>brew install gh</code> (Mac) in a terminal, then reload.</div>');
  box.append(gc);
  const stripped = Object.values(state.status.strippedEnv).flat();
  box.insertAdjacentHTML('beforeend', `<div class="guard"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0l6 2v5c0 4-2.6 7-6 9-3.4-2-6-5-6-9V2z"/></svg><span>Subscription billing guard: API key variables are removed from agent processes${stripped.length ? ` (found ${stripped.join(', ')}, ignored)` : ''}.</span></div>`);
  const dis = !state.status.claude.loggedIn && !state.status.codex.loggedIn;
  $('#runBtn').title = dis ? 'Sign in to at least one agent first' : '';
}

// ---------- sidebar ----------
function renderList() {
  const list = $('#taskList');
  if (!state.tasks.length) { list.innerHTML = '<div class="empty-list">Nothing yet. Your runs will show up here.</div>'; return; }
  list.innerHTML = '';
  for (const t of state.tasks) {
    const b = document.createElement('button');
    b.className = 'task' + (t.id === state.sel ? ' sel' : '');
    b.innerHTML = `<div class="t-prompt">${esc(t.prompt)}</div><div class="t-meta"><span class="pips">${t.runs.map((r) => `<i class="pip ${r.agent} ${r.status}" title="${AGENTS[r.agent].label}: ${r.status}"></i>`).join('')}</span><span>${ago(t.createdAt)}</span></div>`;
    b.onclick = () => select(t.id);
    list.append(b);
  }
}

// ---------- stage ----------
const SOLO_IDEAS = [{ t: 'Find and fix the flakiest test' }, { t: 'Add input validation to the API routes' }, { t: 'Write a README for this project' }, { t: 'Review the repo for security issues' }];
const TEAM_IDEAS = [
  { t: 'Build a todo app with a REST API and a web UI', c: 'Backend: REST API, storage, validation, tests', x: 'Frontend: web UI that consumes the API' },
  { t: 'Add user accounts with login and a profile page', c: 'Backend: auth endpoints, sessions, DB schema', x: 'Frontend: login form, profile page, auth state' },
  { t: 'Add a dark mode and a settings screen', c: 'Backend: persist settings, settings API', x: 'Frontend: theme system, settings screen' },
];
const taskOf = (id) => state.tasks.find((t) => t.id === id);

function select(id) {
  state.sel = id;
  renderList(); renderTop(); renderStage();
}

function renderTop() {
  const t = taskOf(state.sel);
  const top = $('#topbar');
  if (!t) { top.innerHTML = ''; return; }
  top.innerHTML = `<h1 class="prompt-full" title="${esc(t.prompt)}">${esc(t.prompt)}</h1>
    <div class="sub"><span>${esc(t.repo)}</span><span>from ${esc(t.baseBranch)}</span>${t.fresh ? '<span>new project</span>' : ''}${t.ci ? '<span title="The agents were told to run this repo\'s CI checks before finishing">runs CI checks</span>' : ''}<span>${t.team ? 'team - shared branch' : t.mode === 'review' ? 'plan (read-only)' : 'build'}</span><span>${ago(t.createdAt)}</span>
    <span class="grow"></span><button class="mini" id="rerun" title="Load this task back into the composer">Run again</button><button class="mini" id="delTask">Delete</button></div>${compareHtml(t)}`;
  $('#rerun').onclick = () => rerun(t);
  $('#delTask').onclick = async () => {
    if (!confirm('Delete this task and discard both worktrees and branches? Applied changes stay in your repo.')) return;
    await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
  };
}

function compareHtml(t) {
  if (t.team || t.runs.length < 2 || !t.runs.every((r) => ['done', 'failed'].includes(r.status))) return '';
  const ok = t.runs.filter((r) => r.status === 'done' && r.startedAt && r.endedAt);
  const fastest = ok.length > 1 ? ok.reduce((a, b) => (a.endedAt - a.startedAt <= b.endedAt - b.startedAt ? a : b)).agent : null;
  const files = (r) => new Set(r.items.flatMap((i) => i.files || [])).size;
  return `<div class="compare">${t.runs.map((r) => `<div class="cmp ${r.agent}"><b>${AGENTS[r.agent].label}</b>
    <span>${r.status === 'failed' ? 'failed' : dur(r.endedAt - r.startedAt)}</span><span>${files(r)} file${files(r) === 1 ? '' : 's'}</span>
    ${r.usage?.outputTokens != null ? `<span>${kfmt((r.usage.inputTokens || 0) + r.usage.outputTokens)} tok</span>` : ''}${fastest === r.agent ? '<em>fastest</em>' : ''}</div>`).join('')}</div>`;
}
function rerun(t) {
  state.kind = t.team ? 'team' : 'compete'; store('kind', state.kind);
  if (!t.team) { state.agents = new Set(t.runs.map((r) => r.agent)); store('agents', [...state.agents]); state.mode = t.mode; store('mode', state.mode); syncMode(); }
  else { $('#roleClaude').value = t.team.roles.claude; $('#roleCodex').value = t.team.roles.codex; }
  state.models = { claude: t.models?.claude || '', codex: t.models?.codex || '' }; store('models', state.models);
  $('#repo').value = t.repo; checkRepo(); syncKind(); syncModelLabel();
  state.sel = null; renderList(); renderTop(); renderStage();
  $('#prompt').value = t.prompt; autosize(); $('#prompt').focus();
}

function renderStage() {
  const stage = $('#stage');
  const t = taskOf(state.sel);
  if (!t) {
    const team = state.kind === 'team';
    const ideas = team ? TEAM_IDEAS : SOLO_IDEAS;
    stage.innerHTML = `<div class="hero"><div class="orbs"><i></i><i></i></div><h2>${team ? 'Two agents, one codebase' : 'Two agents, one task'}</h2>
      <p>${team ? 'Give each agent a part of the project. They share one working tree and message each other to agree on interfaces. You can step in anytime.' : 'Claude Code and Codex work on the same prompt at the same time, each in its own isolated branch. Compare, then apply the one you like.'}</p>
      <div class="ideas">${ideas.map((x, i) => `<button class="idea" type="button" data-i="${i}">${esc(x.t)}</button>`).join('')}</div></div>`;
    stage.querySelectorAll('.idea').forEach((b) => (b.onclick = () => {
      const x = ideas[b.dataset.i];
      $('#prompt').value = x.t; autosize(); $('#prompt').focus();
      if (team) { $('#roleClaude').value = x.c; $('#roleCodex').value = x.x; }
    }));
    return;
  }
  if (t.team) {
    stage.innerHTML = '<div class="lanes team"></div>';
    const lanes = $('.lanes', stage);
    const run = (a) => t.runs.find((r) => r.agent === a);
    lanes.append(buildLane(t, run('claude')), buildChannel(t), buildLane(t, run('codex')));
    const layer = document.createElement('div'); layer.className = 'flight-layer'; lanes.append(layer);
    return;
  }
  stage.innerHTML = '<div class="lanes"></div>';
  const lanes = $('.lanes', stage);
  for (const r of t.runs) lanes.append(buildLane(t, r));
}

function buildLane(t, r) {
  const el = document.createElement('section');
  el.className = `lane ${r.agent}${t.team ? ' team-lane' : ''}`;
  el.id = `lane-${t.id}-${r.agent}`;
  el.innerHTML = `<div class="lane-head"></div><div class="now" hidden></div><div class="touched" hidden></div>
    <div class="tabs"><button class="tab" data-tab="activity">Activity</button><button class="tab" data-tab="changes">Changes<span class="count"></span></button></div>
    <div class="feed"></div><div class="diff" hidden></div><div class="lane-foot"></div>`;
  el.querySelectorAll('.tab').forEach((b) => (b.onclick = () => { state.tab[`${t.id}:${r.agent}`] = b.dataset.tab; syncTab(t, r); }));
  const feed = $('.feed', el);
  for (const it of r.items) addItem(feed, it, false);
  if (r.status === 'running' && !r.items.length) feed.append(typing());
  syncHead(t, r, el); syncTab(t, r, el); syncNow(t, r, el);
  feed.scrollTop = feed.scrollHeight;
  return el;
}
const typing = () => { const d = document.createElement('div'); d.className = 'typing'; d.innerHTML = '<i></i><i></i><i></i>'; return d; };
const laneEl = (t, r) => document.getElementById(`lane-${t.id}-${r.agent}`);

// What the agent is doing right now, plus every file it has touched.
function syncNow(t, r, el = laneEl(t, r)) {
  if (!el) return;
  const now = $('.now', el);
  const last = [...r.items].reverse().find((i) => i.kind === 'tool');
  now.hidden = !(r.status === 'running' && last);
  if (!now.hidden) now.innerHTML = `<i></i><span>${esc(last.name)}</span><code>${esc(last.summary)}</code>`;
  const files = [...new Set(r.items.flatMap((i) => i.files || []))];
  const box = $('.touched', el);
  box.hidden = !files.length;
  if (files.length) box.innerHTML = files.slice(0, 12).map((f) => `<button class="file-chip" title="${esc(f)}" data-f="${esc(f)}">${esc(f.split('/').pop())}</button>`).join('') + (files.length > 12 ? `<span class="more">+${files.length - 12}</span>` : '');
  box.querySelectorAll('.file-chip').forEach((b) => (b.onclick = () => {
    if (t.team) { state.tab[`${t.id}:team`] = 'changes'; syncChanTab(t); }
    else { state.tab[`${t.id}:${r.agent}`] = 'changes'; syncTab(t, r); }
  }));
}

function syncHead(t, r, el = laneEl(t, r)) {
  if (!el) return;
  el.classList.toggle('is-running', r.status === 'running');
  const u = r.usage || {};
  const elapsed = r.startedAt ? dur((r.endedAt || Date.now()) - r.startedAt) : '';
  const stats = [t.team && r.turns > 1 && `turn ${r.turns}`, elapsed, u.inputTokens != null && `${kfmt(u.inputTokens)} in`, u.outputTokens != null && `${kfmt(u.outputTokens)} out`].filter(Boolean);
  $('.lane-head', el).innerHTML = `<span class="badge">${AGENTS[r.agent].letter}</span><span class="title">${AGENTS[r.agent].label}</span>${t.models?.[r.agent] ? `<span class="model-tag" title="Model">${esc(t.models[r.agent])}</span>` : ''}${t.team ? `<span class="role-tag" title="${esc(t.team.roles[r.agent])}">${esc(t.team.roles[r.agent].split(':')[0])}</span>` : ''}
    <span class="status ${r.status}">${r.status}</span><span class="lane-stats">${stats.map((x) => `<span>${x}</span>`).join('')}</span>`;
  const foot = $('.lane-foot', el);
  foot.innerHTML = '';
  const add = (txt, cls, fn, dis) => { const b = document.createElement('button'); b.className = `btn ${cls || ''}`; b.textContent = txt; b.disabled = !!dis; b.onclick = fn; foot.append(b); return b; };
  if (t.team) {
    if (r.status === 'running') {
      foot.insertAdjacentHTML('beforeend', '<span class="note">Working...</span>');
      add('Stop', 'danger', () => api(`/api/tasks/${t.id}/${r.agent}/cancel`, { method: 'POST' }));
    } else foot.insertAdjacentHTML('beforeend', `<span class="note">${r.status === 'failed' ? 'Failed' : r.status === 'cancelled' ? 'Stopped' : `Turn ${r.turns || 0} finished`} - wakes on new messages</span>`);
  } else if (r.status === 'running' || r.status === 'queued') {
    foot.insertAdjacentHTML('beforeend', '<span class="note">Working...</span>');
    add('Stop', 'danger', () => api(`/api/tasks/${t.id}/${r.agent}/cancel`, { method: 'POST' }));
  } else if (r.discarded) {
    foot.insertAdjacentHTML('beforeend', '<span class="note">Discarded</span>');
  } else if (r.applied) {
    foot.insertAdjacentHTML('beforeend', `<span class="note">Merged into ${esc(t.baseBranch)}</span>`);
    if (canGh(t)) add('Push to GitHub', 'primary', () => doPush(t));
  } else {
    foot.insertAdjacentHTML('beforeend', `<span class="note">${r.changed ? `${r.changed} file${r.changed > 1 ? 's' : ''} changed` : 'No file changes'} on <code>${esc(r.branch || '')}</code></span>`);
    add('Discard', 'danger', async () => { await api(`/api/tasks/${t.id}/${r.agent}/discard`, { method: 'POST' }).catch((e) => toast(e.message, true)); });
    if (canGh(t)) add(r.prUrl ? 'View PR' : 'Open PR', '', () => (r.prUrl ? window.open(r.prUrl, '_blank', 'noopener') : doPr(t, r.agent, AGENTS[r.agent].label)), !r.changed && !r.prUrl);
    add(`Apply to ${t.baseBranch}`, 'primary', async () => {
      try { await api(`/api/tasks/${t.id}/${r.agent}/apply`, { method: 'POST' }); toast(`${AGENTS[r.agent].label} changes merged into ${t.baseBranch}.`); }
      catch (e) { toast(e.message, true); }
    }, !r.changed);
  }
  const cnt = $('.count', el);
  if (cnt) cnt.textContent = r.changed ? r.changed : '';
}

function diffHtml(diff, stat, who) {
  let html = `<div class="stat">${esc(stat.trim())}</div>`;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) { const f = line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'); html += `<div class="file">${who ? who(f).map((a) => `<i class="who ${a}" title="${AGENTS[a].label}"></i>`).join('') : ''}${esc(f)}</div>`; }
    else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity)/.test(line)) continue;
    else if (line.startsWith('@@')) html += `<div class="ln hunk">${esc(line)}</div>`;
    else html += `<div class="ln ${line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : ''}">${esc(line) || ' '}</div>`;
  }
  return html;
}

// ---------- team channel ----------
const chanEl = (t) => document.getElementById(`chan-${t.id}`);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const nameOf = (x) => (x === 'you' ? 'You' : x === 'all' ? 'Everyone' : AGENTS[x]?.label || x);
const CHAT_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>';

function buildChannel(t) {
  const el = document.createElement('section');
  el.className = 'channel'; el.id = `chan-${t.id}`; el.style.setProperty('--c', 'var(--ink)');
  el.innerHTML = `<div class="chan-head"><span class="ttl">${CHAT_ICON}Channel</span><span class="status"></span></div>
    <div class="comm" aria-hidden="true"><div class="node claude"><i></i><div><b>Claude</b><small>idle</small></div></div><div class="wire"><span class="pulse"></span></div><div class="node codex"><div><b>Codex</b><small>idle</small></div><i></i></div></div>
    <div class="chan-tabs tabs"><button class="tab" data-tab="messages">Messages</button><button class="tab" data-tab="changes">Changes<span class="count"></span></button></div>
    <div class="chan-msgs"></div><div class="diff" hidden></div>
    <form class="chan-input"><select aria-label="Send to"><option value="all">Everyone</option><option value="claude">Claude</option><option value="codex">Codex</option></select>
      <input placeholder="Steer your agents..." aria-label="Message" autocomplete="off"><button class="btn primary" type="submit">Send</button></form>
    <div class="lane-foot chan-foot"></div>`;
  el.querySelectorAll('.tab').forEach((b) => (b.onclick = () => { state.tab[`${t.id}:team`] = b.dataset.tab; syncChanTab(t); }));
  $('.chan-input', el).onsubmit = async (e) => {
    e.preventDefault();
    const input = $('input', el); const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try { await api(`/api/tasks/${t.id}/message`, { method: 'POST', body: { to: $('select', el).value, text } }); }
    catch (err) { toast(err.message, true); input.value = text; }
  };
  const box = $('.chan-msgs', el);
  if (t.team.messages.length) t.team.messages.forEach((m) => addMessage(box, m, false)); else emptyChannel(box);
  syncChanFoot(t, el); syncChanTab(t, el);
  box.scrollTop = box.scrollHeight;
  return el;
}
function emptyChannel(box) {
  box.innerHTML = `<div class="chan-empty">${CHAT_ICON.replace('width="15" height="15"', 'width="26" height="26"')}Messages between the agents, and from you, show up here. Send one to steer them.</div>`;
}
function addMessage(box, m, scroll = true) {
  box.querySelector('.chan-empty')?.remove();
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  const prev = box.lastElementChild;
  if (m.from === 'you' && prev && prev.dataset.from === 'you' && prev.dataset.text === m.text && Math.abs(m.ts - Number(prev.dataset.ts)) < 3000 && prev.dataset.to !== m.to) {
    prev.dataset.to = 'all'; prev.querySelectorAll('.msg-meta b')[1].textContent = 'Everyone'; return; // one human message sent to both
  }
  const d = document.createElement('div');
  Object.assign(d.dataset, { from: m.from, to: m.to, text: m.text, ts: m.ts });
  d.className = `msg from-${m.from} to-${m.to}${scroll ? ' fresh' : ''}`;
  d.innerHTML = `<div class="msg-meta"><b${m.to === 'you' ? ' class="ask"' : ''}>${esc(nameOf(m.from))}</b><span class="arrow">to</span><b>${esc(nameOf(m.to))}</b><span>${fmtTime(m.ts)}</span></div><div class="msg-body">${esc(m.text).replace(/\n/g, '<br>')}</div>`;
  box.append(d);
  if (scroll && near) box.scrollTop = box.scrollHeight;
}
// ---------- message flights: a glowing packet travels between the agents ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const flightQ = []; let flying = false;
function queueFlight(t, m) {
  if (reducedMotion) return;
  flightQ.push([t, m]);
  if (!flying) (async () => { flying = true; while (flightQ.length) { const [tt, mm] = flightQ.shift(); await flyMessage(tt, mm).catch(() => {}); await sleep(90); } flying = false; })();
}
async function flyMessage(t, m) {
  const lanes = $('.lanes.team'); const layer = lanes && $('.flight-layer', lanes); const chan = chanEl(t);
  if (!layer || !chan || state.sel !== t.id) return;
  const lr = lanes.getBoundingClientRect();
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2 - lr.left, y: r.top + r.height / 2 - lr.top }; };
  const badge = (a) => document.querySelector(`#lane-${t.id}-${a} .badge`);
  const input = $('.chan-input', chan);
  const srcEl = m.from === 'you' ? input : badge(m.from);
  const dstEl = m.to === 'you' ? input : badge(m.to);
  if (!srcEl || !dstEl) return;
  const A = center(srcEl), B = center(dstEl);
  const color = m.from === 'claude' ? 'var(--claude)' : m.from === 'codex' ? 'var(--codex)' : m.to === 'you' ? 'var(--warn)' : '#fff';
  const lift = m.from === 'you' || m.to === 'you' ? 30 : 60;
  const C = { x: (A.x + B.x) / 2, y: Math.min(A.y, B.y) - lift };
  const N = 28, ease = (u) => (u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const frames = Array.from({ length: N + 1 }, (_, i) => {
    const u = ease(i / N), v = 1 - u;
    const x = v * v * A.x + 2 * v * u * C.x + u * u * B.x, y = v * v * A.y + 2 * v * u * C.y + u * u * B.y;
    const sc = 1 + Math.sin((i / N) * Math.PI) * .5;
    return { transform: `translate(${x}px, ${y}px) scale(${sc})`, offset: i / N };
  });
  const DUR = 1150;
  const mk = (cls) => { const e = document.createElement('div'); e.className = cls; e.style.setProperty('--pc', color); layer.append(e); return e; };

  wirePulse(chan, m);
  const nodes = [];
  for (let k = 5; k >= 1; k--) { // trail
    const g = mk('packet ghost'); nodes.push(g);
    g.style.opacity = String(.5 - k * .08); g.style.width = g.style.height = `${14 - k * 1.6}px`; g.style.margin = `${-(14 - k * 1.6) / 2}px 0 0 ${-(14 - k * 1.6) / 2}px`;
    g.animate(frames, { duration: DUR, delay: k * 38, easing: 'linear', fill: 'both' });
  }
  const cap = mk('cap-bubble'); nodes.push(cap);
  cap.textContent = m.text.length > 64 ? m.text.slice(0, 63) + '…' : m.text;
  cap.style.left = `${C.x}px`; cap.style.top = `${(A.y + B.y) / 2 - lift * .55 - 10}px`;
  cap.animate([{ opacity: 0, transform: 'translate(-50%,-80%) scale(.9)' }, { opacity: 1, transform: 'translate(-50%,-100%) scale(1)', offset: .25 }, { opacity: 1, transform: 'translate(-50%,-100%) scale(1)', offset: .75 }, { opacity: 0, transform: 'translate(-50%,-110%) scale(.96)' }], { duration: DUR + 250, easing: 'ease-out', fill: 'both' });
  const p = mk('packet'); nodes.push(p);
  await p.animate(frames, { duration: DUR, easing: 'linear', fill: 'both' }).finished;

  const lane = m.to === 'claude' || m.to === 'codex' ? document.getElementById(`lane-${t.id}-${m.to}`) : null;
  if (lane) {
    const ring = document.createElement('div'); ring.className = 'ring'; ring.style.setProperty('--rc', color); lane.append(ring); setTimeout(() => ring.remove(), 1000);
    dstEl.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)' });
  } else dstEl.animate([{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: `0 0 0 3px ${getComputedStyle(document.documentElement).getPropertyValue('--warn')}` }, { boxShadow: '0 0 0 0 transparent' }], { duration: 700 });
  setTimeout(() => nodes.forEach((n) => n.remove()), 400);
}
function wirePulse(chan, m) {
  const wire = $('.comm .wire', chan); const pulse = wire && $('.pulse', wire);
  if (!pulse || (m.from !== 'claude' && m.from !== 'codex')) return;
  const w = wire.clientWidth, dir = m.from === 'claude' ? 1 : -1;
  wire.style.setProperty('--wc', m.from === 'claude' ? 'var(--claude)' : 'var(--codex)');
  wire.classList.add('hot'); setTimeout(() => wire.classList.remove('hot'), 1300);
  pulse.animate([{ transform: `translateX(${dir > 0 ? -30 : w}px)`, opacity: 0 }, { opacity: 1, offset: .2 }, { opacity: 1, offset: .8 }, { transform: `translateX(${dir > 0 ? w : -30}px)`, opacity: 0 }], { duration: 1150, easing: 'ease-in-out' });
}

function syncChanFoot(t, el = chanEl(t)) {
  if (!el) return;
  const running = t.runs.some((r) => r.status === 'running');
  const st = $('.chan-head .status', el);
  st.className = 'status ' + (running ? 'running' : 'done'); st.textContent = running ? 'live' : 'idle';
  $('.count', el).textContent = t.team.changed || '';
  for (const r of t.runs) {
    const n = $(`.comm .node.${r.agent}`, el);
    n.classList.toggle('live', r.status === 'running');
    $('small', n).textContent = r.status === 'running' ? (r.turns > 1 ? `turn ${r.turns}` : 'working') : 'idle';
  }
  const foot = $('.chan-foot', el); foot.innerHTML = '';
  const add = (txt, cls, fn, dis) => { const b = document.createElement('button'); b.className = `btn ${cls || ''}`; b.textContent = txt; b.disabled = !!dis; b.onclick = fn; foot.append(b); };
  const note = (h) => foot.insertAdjacentHTML('beforeend', `<span class="note">${h}</span>`);
  if (t.team.discarded) return note('Discarded');
  if (t.team.applied) { note(`Merged into ${esc(t.baseBranch)}`); if (canGh(t)) add('Push to GitHub', 'primary', () => doPush(t)); return; }
  if (running) {
    note('Agents are working...');
    add('Stop all', 'danger', () => t.runs.filter((r) => r.status === 'running').forEach((r) => api(`/api/tasks/${t.id}/${r.agent}/cancel`, { method: 'POST' })));
    return;
  }
  note(`${t.team.changed ? `${t.team.changed} file${t.team.changed > 1 ? 's' : ''} changed` : 'No file changes'} on <code>${esc(t.team.branch)}</code>`);
  add('Discard', 'danger', () => api(`/api/tasks/${t.id}/team/discard`, { method: 'POST' }).catch((e) => toast(e.message, true)));
  if (canGh(t)) add(t.team.prUrl ? 'View PR' : 'Open PR', '', () => (t.team.prUrl ? window.open(t.team.prUrl, '_blank', 'noopener') : doPr(t, 'team', 'the team')), !t.team.changed && !t.team.prUrl);
  add(`Apply to ${t.baseBranch}`, 'primary', async () => {
    try { await api(`/api/tasks/${t.id}/team/apply`, { method: 'POST' }); toast(`Team changes merged into ${t.baseBranch}.`); }
    catch (e) { toast(e.message, true); }
  }, !t.team.changed);
}
async function syncChanTab(t, el = chanEl(t)) {
  if (!el) return;
  const tab = state.tab[`${t.id}:team`] || 'messages';
  el.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('.chan-msgs', el).hidden = tab !== 'messages';
  const d = $('.diff', el); d.hidden = tab !== 'changes';
  if (tab !== 'changes') return;
  d.innerHTML = '<div class="empty">Loading changes...</div>';
  try {
    const { diff, stat } = await api(`/api/tasks/${t.id}/team/diff`);
    d.innerHTML = diff.trim() ? diffHtml(diff, stat, (f) => t.runs.filter((r) => r.items.some((i) => (i.files || []).includes(f))).map((r) => r.agent)) : '<div class="empty">No changes yet.</div>';
  } catch (e) { d.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function syncTab(t, r, el = laneEl(t, r)) {
  if (!el) return;
  const tab = state.tab[`${t.id}:${r.agent}`] || 'activity';
  el.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('.feed', el).hidden = tab !== 'activity';
  const d = $('.diff', el);
  d.hidden = tab !== 'changes';
  if (tab !== 'changes') return;
  d.innerHTML = '<div class="empty">Loading changes...</div>';
  try {
    const { diff, stat } = r.discarded ? { diff: '', stat: '' } : await api(`/api/tasks/${t.id}/${r.agent}/diff`);
    if (!diff.trim()) { d.innerHTML = `<div class="empty">${r.status === 'running' ? 'No changes yet.' : 'No changes.'}</div>`; return; }
    d.innerHTML = diffHtml(diff, stat);
  } catch (e) { d.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

const HINTS = {
  limit: 'Looks like a usage limit on your plan. Wait for it to reset, or run a single agent to use less.',
  auth: 'Your session may have expired. Use Sign in in the sidebar, then run again.',
};
function addItem(feed, it, scroll = true) {
  feed.querySelector('.typing')?.remove();
  const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  let el;
  if (it.kind === 'tool') {
    el = document.createElement('details');
    el.className = 'item tool wait';
    el.dataset.id = it.id || '';
    el.innerHTML = `<summary><span class="tool-name">${esc(it.name)}</span><span class="tool-sum">${esc(it.summary)}</span><span class="tool-state"></span></summary>`;
  } else if (it.kind === 'tool_result') {
    const tool = [...feed.querySelectorAll('.item.tool')].reverse().find((x) => x.dataset.id === it.id);
    if (tool) {
      tool.classList.remove('wait'); tool.classList.add(it.error ? 'bad' : 'ok');
      if (it.text && it.text.trim()) { const o = document.createElement('div'); o.className = 'tool-out'; o.textContent = it.text; tool.append(o); }
    }
    return;
  } else if (it.kind === 'text') {
    el = document.createElement('div'); el.className = 'item text'; el.innerHTML = md(it.text);
  } else if (it.kind === 'final') {
    el = document.createElement('div'); el.className = 'item text final'; el.innerHTML = `<div class="lbl"><span>Result</span><button class="copy" type="button">Copy</button></div>${md(it.text)}`;
    $('.copy', el).onclick = (e) => { navigator.clipboard?.writeText(it.text).then(() => { e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1400); }); };
  } else if (it.kind === 'error') {
    el = document.createElement('div'); el.className = 'item error'; el.innerHTML = `<div class="err-text">${esc(it.text)}</div>${HINTS[it.hint] ? `<div class="hint">${HINTS[it.hint]}</div>` : ''}`;
  } else if (it.kind === 'meta') {
    el = document.createElement('div'); el.className = 'item meta'; el.textContent = it.text;
  } else {
    el = document.createElement('div'); el.className = 'item tool-out'; el.textContent = it.text;
  }
  feed.append(el);
  if (scroll && near) feed.scrollTop = feed.scrollHeight;
}

// ---------- model choice ----------
// Presets are the stable Claude Code aliases. Anything else goes in the custom box, so new models work without an update.
const MODEL_PRESETS = {
  claude: [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['opusplan', 'Opus plans, Sonnet builds']],
  codex: [['', 'Default']],
};
const modelShort = (a, v) => (v ? (MODEL_PRESETS[a].find((x) => x[0] === v)?.[1] || v) : 'auto');
function syncModelLabel() {
  const m = state.models;
  const parts = state.kind === 'team' || state.agents.size === 2 ? ['claude', 'codex'] : [...state.agents];
  $('#modelLabel').textContent = parts.map((a) => modelShort(a, m[a])).join(' · ') || 'Models';
  $('#modelBtn').classList.toggle('set', Object.values(m).some(Boolean));
}
function closeModels() { $('#models').hidden = true; state.modelsOpen = false; }
function openModels() {
  const box = $('#models');
  closeProj?.();
  state.modelsOpen = true; box.hidden = false;
  box.innerHTML = `<div class="mdl-head"><b>Models</b><button type="button" class="proj-x" aria-label="Close">×</button></div>
    ${['claude', 'codex'].map((a) => {
      const cur = state.models[a] || '';
      const isPreset = MODEL_PRESETS[a].some((x) => x[0] === cur);
      return `<div class="mdl-row ${a}"><div class="mdl-name"><i></i>${AGENTS[a].label}</div>
        <div class="mdl-opts">${MODEL_PRESETS[a].map(([v, l]) => `<button type="button" class="mdl-opt${cur === v ? ' on' : ''}" data-a="${a}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}
        <input class="mdl-custom${!isPreset ? ' on' : ''}" data-a="${a}" value="${isPreset ? '' : esc(cur)}" placeholder="${a === 'claude' ? 'or a model id, e.g. claude-opus-5-5' : 'a model id, e.g. gpt-5-codex'}" spellcheck="false" aria-label="Custom ${AGENTS[a].label} model"></div></div>`;
    }).join('')}
    <p class="mdl-note">Default uses whatever each CLI is already set to. Anything your account can use works as a custom id. Applies to the next run.</p>`;
  $('.proj-x', box).onclick = closeModels;
  const save = () => { store('models', state.models); syncModelLabel(); };
  box.querySelectorAll('.mdl-opt').forEach((b) => (b.onclick = () => {
    state.models[b.dataset.a] = b.dataset.v; save(); openModels();
  }));
  box.querySelectorAll('.mdl-custom').forEach((i) => {
    i.oninput = () => { state.models[i.dataset.a] = i.value.trim(); i.classList.toggle('on', !!i.value.trim()); save(); box.querySelectorAll(`.mdl-opt[data-a="${i.dataset.a}"]`).forEach((b) => b.classList.toggle('on', b.dataset.v === state.models[i.dataset.a])); };
  });
}
$('#modelBtn').onclick = () => (state.modelsOpen ? closeModels() : openModels());
document.addEventListener('mousedown', (e) => { if (state.modelsOpen && !e.target.closest('#models, #modelBtn')) closeModels(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.modelsOpen) closeModels(); });

// ---------- GitHub: connect, pick / clone / create projects, PRs ----------
function githubInstallHelp() {
  toast('Install the GitHub CLI: run "brew install gh" in a terminal (https://cli.github.com), then reload this page.', true);
}
async function connectGithub() {
  let st;
  try { st = await api('/api/github/login', { method: 'POST' }); } catch (e) { return toast(e.message, true); }
  const m = document.createElement('div');
  m.className = 'palette'; m.id = 'ghModal';
  m.innerHTML = `<div class="pal-box gh-box" role="dialog" aria-label="Connect GitHub">
    <h3>Connect GitHub</h3>
    <p>A browser tab is opening on this computer. Enter this code there to let Duo create repos and open pull requests.</p>
    <div class="code" id="ghCode">starting...</div>
    <div class="gh-actions"><button class="btn" id="ghCopy" type="button">Copy code</button><a class="btn primary" href="https://github.com/login/device" target="_blank" rel="noopener">Open github.com/login/device</a></div>
    <div class="gh-msg" id="ghMsg">Waiting for you to approve...</div><button class="mini gh-close" type="button">Cancel</button></div>`;
  document.body.append(m);
  const close = () => { clearInterval(iv); m.remove(); };
  $('.gh-close', m).onclick = close;
  m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
  $('#ghCopy', m).onclick = () => navigator.clipboard?.writeText($('#ghCode', m).textContent);
  const iv = setInterval(async () => {
    const g = await api('/api/github').catch(() => null);
    if (!g) return;
    if (g.login?.code) $('#ghCode', m).textContent = g.login.code;
    if (g.login?.error) { $('#ghMsg', m).textContent = g.login.error; $('#ghMsg', m).classList.add('bad'); clearInterval(iv); }
    else if (g.login?.done && g.loggedIn) { close(); toast(`GitHub connected as @${g.user}`); loadStatus(); if (state.projOpen) openProj(state.projTab); }
  }, 1200);
}

const canGh = (t) => !!t.remote && !!state.status?.github?.loggedIn;
async function doPr(t, key, who) {
  try {
    toast(`Pushing ${who} and opening a pull request...`);
    const { url } = await api(`/api/tasks/${t.id}/${key}/pr`, { method: 'POST' });
    toast('Pull request opened.', false, url);
    if (url) window.open(url, '_blank', 'noopener');
  } catch (e) { toast(e.message, true); }
}
async function doPush(t) {
  try { await api(`/api/tasks/${t.id}/push`, { method: 'POST' }); toast(`Pushed ${t.baseBranch} to GitHub.`); }
  catch (e) { toast(e.message, true); }
}

function pickProject(dir) {
  $('#repo').value = dir; store('repo', dir);
  const recent = [dir, ...(store('repos') || []).filter((x) => x !== dir)].slice(0, 8); store('repos', recent); fillRecent();
  checkRepo(); closeProj(); $('#prompt').focus();
}
function closeProj() { $('#proj').hidden = true; state.projOpen = false; }
async function openProj(tab = 'recent') {
  if (state.modelsOpen) closeModels();
  const box = $('#proj');
  state.projOpen = true; state.projTab = tab;
  box.hidden = false;
  const g = await api('/api/github').catch(() => ({}));
  const dir = store('projDir') || g.defaultDir || '';
  const tabs = [['recent', 'Recent'], ['github', 'Your GitHub repos'], ['new', 'New project']];
  box.innerHTML = `<div class="proj-head"><div class="proj-tabs">${tabs.map(([k, l]) => `<button type="button" class="ptab${k === tab ? ' on' : ''}" data-t="${k}">${l}</button>`).join('')}</div><button type="button" class="proj-x" aria-label="Close">×</button></div>
    <div class="proj-body"></div>
    <label class="proj-dir ${tab === 'recent' ? 'hide' : ''}"><span>Save to</span><input id="projDir" value="${esc(dir)}" spellcheck="false"></label>`;
  box.querySelectorAll('.ptab').forEach((b) => (b.onclick = () => openProj(b.dataset.t)));
  $('.proj-x', box).onclick = closeProj;
  const body = $('.proj-body', box);
  const dirVal = () => { const v = $('#projDir', box).value.trim(); store('projDir', v); return v; };
  const needGh = (what) => `<div class="proj-empty"><p>${g.installed ? `Connect GitHub to ${what}.` : 'The GitHub CLI (gh) is not installed. Run <code>brew install gh</code> in a terminal, then reload.'}</p>${g.installed ? '<button type="button" class="btn primary" id="projConnect">Connect GitHub</button>' : ''}</div>`;

  if (tab === 'recent') {
    const rec = store('repos') || [];
    body.innerHTML = rec.length ? rec.map((r) => `<button type="button" class="proj-item" data-p="${esc(r)}"><b>${esc(r.split('/').filter(Boolean).pop())}</b><span>${esc(r)}</span></button>`).join('') : '<div class="proj-empty"><p>No recent projects yet. Clone one from GitHub or create a new one.</p></div>';
    body.querySelectorAll('.proj-item').forEach((b) => (b.onclick = () => pickProject(b.dataset.p)));
  } else if (tab === 'github') {
    if (!g.loggedIn) { body.innerHTML = needGh('see your repositories'); $('#projConnect')?.addEventListener('click', connectGithub); return; }
    body.innerHTML = '<input class="proj-search" placeholder="Search your repositories..." aria-label="Search repositories"><div class="proj-list"><div class="proj-empty"><p>Loading...</p></div></div>';
    let repos = [];
    const list = $('.proj-list', body);
    const draw = () => {
      const q = $('.proj-search', body).value.toLowerCase();
      const items = repos.filter((r) => r.nameWithOwner.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
      list.innerHTML = items.map((r) => `<div class="proj-item" data-r="${esc(r.nameWithOwner)}"><div><b>${esc(r.nameWithOwner)}</b>${r.isPrivate ? '<em>private</em>' : ''}<span>${esc(r.description || '')}</span></div><button type="button" class="mini ${r.local ? '' : 'primary'}">${r.local ? 'Use' : 'Clone & use'}</button></div>`).join('') || '<div class="proj-empty"><p>No matching repositories.</p></div>';
      list.querySelectorAll('.proj-item').forEach((row) => ($('button', row).onclick = async (e) => {
        const btn = e.currentTarget; const slug = row.dataset.r; const r = repos.find((x) => x.nameWithOwner === slug);
        if (r.local) return pickProject(r.local);
        btn.disabled = true; btn.textContent = 'Cloning...';
        try { const out = await api('/api/projects/clone', { method: 'POST', body: { repo: slug, dir: dirVal() } }); toast(`Cloned ${slug}`); pickProject(out.path); }
        catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Clone & use'; }
      }));
    };
    $('.proj-search', body).oninput = draw;
    api('/api/github/repos?dir=' + encodeURIComponent(dir)).then((r) => { repos = r; draw(); }).catch((e) => { list.innerHTML = `<div class="proj-empty"><p>${esc(e.message)}</p></div>`; });
  } else {
    body.innerHTML = `<div class="proj-form">
      <label>Name<input id="npName" placeholder="my-new-app" spellcheck="false" autocomplete="off"></label>
      <label>Description <small>optional</small><input id="npDesc" placeholder="What is it?"></label>
      <div class="proj-row"><div class="seg" id="npVis"><button type="button" class="on" data-v="private">Private</button><button type="button" data-v="public">Public</button></div>
      <label class="chk"><input type="checkbox" id="npGh" ${g.loggedIn ? 'checked' : 'disabled'}> Create on GitHub</label></div>
      ${g.loggedIn ? '' : '<p class="muted">Not connected to GitHub yet, so this will be a local project. <a href="#" id="projConnect">Connect GitHub</a></p>'}
      <button type="button" class="btn primary" id="npGo">Create project</button></div>`;
    let vis = 'private';
    body.querySelectorAll('#npVis button').forEach((b) => (b.onclick = () => { vis = b.dataset.v; body.querySelectorAll('#npVis button').forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#projConnect')?.addEventListener('click', (e) => { e.preventDefault(); connectGithub(); });
    const go = async () => {
      const btn = $('#npGo', body); btn.disabled = true; btn.textContent = 'Creating...';
      try {
        const out = await api('/api/projects/create', { method: 'POST', body: { name: $('#npName', body).value, description: $('#npDesc', body).value, visibility: vis, github: $('#npGh', body).checked, dir: dirVal() } });
        toast(out.github ? 'Created on GitHub.' : 'Created locally.', false, out.url); pickProject(out.path);
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Create project'; }
    };
    $('#npGo', body).onclick = go;
    $('#npName', body).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    $('#npName', body).focus();
  }
}
$('#projBtn').onclick = () => (state.projOpen ? closeProj() : openProj(state.status?.github?.loggedIn ? 'github' : 'recent'));
document.addEventListener('mousedown', (e) => { if (state.projOpen && !e.target.closest('#proj, #projBtn, #ghModal')) closeProj(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.projOpen && !$('#palette')) closeProj(); });

// ---------- attention: title, notification, connection ----------
const BASE_TITLE = document.title;
let notified = new Set();
function maybeNotify(t) {
  const idle = t.runs.every((r) => ['done', 'failed', 'cancelled', 'interrupted'].includes(r.status));
  if (!idle) return;
  if (t.team && t.runs.some((r) => r.status === 'done') === false) return;
  const key = `${t.id}:${t.runs.map((r) => r.turns || 0).join('.')}`;
  if (notified.has(key)) return; notified.add(key);
  if (!document.hidden) return;
  const bad = t.runs.some((r) => r.status === 'failed');
  document.title = `${bad ? '! ' : '✓ '}${t.prompt.slice(0, 40)} - Duo`;
  try { if (Notification.permission === 'granted') new Notification(bad ? 'Duo: a run failed' : 'Duo: finished', { body: t.prompt.slice(0, 120), silent: true }); } catch { /* unsupported */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = BASE_TITLE; });
function setConn(ok) {
  let b = $('#conn');
  if (ok) { b?.remove(); return; }
  if (!b) { b = document.createElement('div'); b.id = 'conn'; b.className = 'conn'; b.textContent = 'Reconnecting to Duo...'; document.body.append(b); }
}

// ---------- live events ----------
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'task') {
      if (taskOf(ev.task.id)) return;
      state.tasks.unshift(ev.task); renderList();
      if (!state.sel || state.sel !== ev.task.id) select(ev.task.id);
      return;
    }
    if (ev.type === 'deleted') {
      state.tasks = state.tasks.filter((t) => t.id !== ev.taskId);
      if (state.sel === ev.taskId) state.sel = null;
      renderList(); renderTop(); renderStage(); return;
    }
    const t = taskOf(ev.taskId);
    if (t && ev.type === 'message') {
      t.team.messages.push(ev.msg);
      if (state.sel === t.id && chanEl(t)) { addMessage($('.chan-msgs', chanEl(t)), ev.msg); queueFlight(t, ev.msg); }
      return;
    }
    if (t && ev.type === 'team') {
      Object.assign(t.team, ev.team);
      if (state.sel === t.id) { syncChanFoot(t); if (state.tab[`${t.id}:team`] === 'changes') syncChanTab(t); }
      return;
    }
    const r = t && t.runs.find((x) => x.agent === ev.agent);
    if (!r) return;
    if (ev.type === 'item') {
      r.items.push(ev.item);
      if (state.sel === t.id) { const l = laneEl(t, r); if (l) { addItem($('.feed', l), ev.item); syncNow(t, r, l); } }
    } else if (ev.type === 'usage') {
      r.usage = ev.usage; if (state.sel === t.id) syncHead(t, r);
    } else if (ev.type === 'status') {
      r.status = ev.status; Object.assign(r, ev.extra || {});
      renderList();
      if (t.team && state.sel === t.id) syncChanFoot(t);
      if (state.sel === t.id) {
        syncHead(t, r); syncNow(t, r);
        if (['done', 'failed', 'cancelled'].includes(ev.status)) { renderTop(); if (state.tab[`${t.id}:${r.agent}`] === 'changes') syncTab(t, r); }
      }
      maybeNotify(t);
    }
  };
  let opened = false;
  es.onopen = async () => { // after a dropped connection, reload anything we missed
    if (opened) { state.tasks = await api('/api/tasks').catch(() => state.tasks); renderList(); renderTop(); renderStage(); }
    opened = true; setConn(true);
  };
  es.onerror = () => setConn(false);
}

// ---------- composer ----------
function autosize() { const p = $('#prompt'); p.style.height = 'auto'; p.style.height = Math.min(p.scrollHeight, 220) + 'px'; }
$('#prompt').addEventListener('input', autosize);

function syncChips() {
  document.querySelectorAll('.chip').forEach((c) => { const on = state.agents.has(c.dataset.agent); c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); });
  const n = state.agents.size;
  if (typeof syncModelLabel === 'function') syncModelLabel();
  if (state.kind === 'team') { $('#prompt').placeholder = 'Describe the overall goal. Both agents see it, plus their own part...'; $('#runBtn').disabled = false; return; }
  $('#prompt').placeholder = n === 2 ? 'Describe a task for both agents...' : n === 1 ? `Describe a task for ${AGENTS[[...state.agents][0]].label}...` : 'Pick at least one agent';
  $('#runBtn').disabled = n === 0;
}
document.querySelectorAll('.chip').forEach((c) => (c.onclick = () => {
  const a = c.dataset.agent; state.agents.has(a) ? state.agents.delete(a) : state.agents.add(a);
  store('agents', [...state.agents]); syncChips();
}));
function syncKind() {
  const team = state.kind === 'team';
  $('#composer').classList.toggle('team-mode', team);
  $('#teamRoles').hidden = !team;
  document.querySelectorAll('.seg.kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === state.kind));
  syncChips();
  if (!state.sel) renderStage();
}
document.querySelectorAll('.seg.kind button').forEach((b) => (b.onclick = () => { state.kind = b.dataset.kind; store('kind', state.kind); syncKind(); }));
$('#swapRoles').onclick = () => { const a = $('#roleClaude'), b = $('#roleCodex'); [a.value, b.value] = [b.value, a.value]; };
function syncMode() { document.querySelectorAll('.seg:not(.kind) button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode)); }
document.querySelectorAll('.seg:not(.kind) button').forEach((b) => (b.onclick = () => { state.mode = b.dataset.mode; store('mode', state.mode); syncMode(); }));

let repoTimer;
async function checkRepo() {
  const v = $('#repo').value.trim(); const badge = $('#repoBadge');
  if (!v) { badge.textContent = ''; return null; }
  try {
    const r = await api('/api/repo?path=' + encodeURIComponent(v));
    badge.className = 'repo-badge ' + (r.git ? (r.dirty ? 'warn' : 'ok') : r.empty ? 'ok' : 'warn');
    badge.textContent = !r.exists ? 'new folder' : !r.git ? (r.empty ? 'empty folder' : 'not git yet') : !r.hasCommits ? 'new repo' : r.dirty ? `${r.branch} - ${r.dirty} uncommitted` : r.branch;
    badge.title = !r.exists ? 'This folder will be created and set up as a git repo.' : !r.git ? (r.empty ? 'Will be set up as a git repo when you run.' : 'You will be asked before git is set up here.') : !r.hasCommits ? 'Empty repo: Duo adds a first commit when you run.' : '';
    if (r.remote && /github\.com/.test(r.remote)) badge.textContent += ' · GitHub';
    if (r.dirty) badge.title = 'Uncommitted changes are not visible to the agents; they branch from the last commit.';
    return r;
  } catch { return null; }
}
$('#repo').addEventListener('input', () => { clearTimeout(repoTimer); repoTimer = setTimeout(checkRepo, 250); });

async function submit(e) {
  e && e.preventDefault();
  const prompt = $('#prompt').value.trim();
  const team = state.kind === 'team';
  if (!prompt || (!team && !state.agents.size)) return;
  const repo = $('#repo').value.trim();
  try { if (Notification.permission === 'default') Notification.requestPermission(); } catch { /* unsupported */ }
  const btn = $('#runBtn'); btn.disabled = true;
  try {
    const body = { prompt, repo, kind: state.kind, agents: [...state.agents], mode: state.mode, roles: { claude: $('#roleClaude').value, codex: $('#roleCodex').value }, models: { ...state.models } };
    try { await api('/api/tasks', { method: 'POST', body }); }
    catch (err) {
      if (err.code !== 'needs_init' || !confirm(`${repo} is not a git repository.\n\nSet up git there and commit its current files so the agents can work on it?`)) throw err;
      await api('/api/tasks', { method: 'POST', body: { ...body, initGit: true } });
    }
    const recent = [repo, ...(store('repos') || []).filter((x) => x !== repo)].slice(0, 8);
    store('repos', recent); store('repo', repo); fillRecent();
    store('history', [prompt, ...(store('history') || []).filter((x) => x !== prompt)].slice(0, 40)); hist = -1;
    $('#prompt').value = ''; autosize();
  } catch (err) { toast(err.message, true); }
  btn.disabled = state.kind !== 'team' && state.agents.size === 0;
}
$('#composer').addEventListener('submit', submit);
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); });
let hist = -1;
$('#prompt').addEventListener('keydown', (e) => {
  const p = e.target, h = store('history') || [];
  if (e.key === 'ArrowUp' && (!p.value || hist >= 0) && p.selectionStart === 0 && h.length) { e.preventDefault(); hist = Math.min(hist + 1, h.length - 1); p.value = h[hist]; autosize(); }
  else if (e.key === 'ArrowDown' && hist >= 0) { e.preventDefault(); hist -= 1; p.value = hist >= 0 ? h[hist] : ''; autosize(); }
});
function fillRecent() { $('#recentRepos').innerHTML = (store('repos') || []).map((r) => `<option value="${esc(r)}">`).join(''); }

$('#newTask').onclick = () => { state.sel = null; renderList(); renderTop(); renderStage(); $('#prompt').focus(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#newTask').click(); }
});

// ---------- command palette ----------
function openPalette() {
  if ($('#palette')) return;
  const cmds = [
    { t: 'New task', k: 'N', run: () => $('#newTask').click() },
    { t: 'Switch to Compete mode', run: () => { state.kind = 'compete'; store('kind', 'compete'); syncKind(); } },
    { t: 'Switch to Team mode', run: () => { state.kind = 'team'; store('kind', 'team'); syncKind(); } },
    { t: 'Sign in / out: Claude Code', run: () => document.querySelector('.acct.claude .mini')?.click() },
    { t: 'Sign in / out: Codex', run: () => document.querySelector('.acct.codex .mini')?.click() },
    ...state.tasks.map((x) => ({ t: x.prompt.slice(0, 80), k: x.team ? 'team' : 'compete', run: () => select(x.id) })),
  ];
  const el = document.createElement('div');
  el.id = 'palette'; el.className = 'palette';
  el.innerHTML = '<div class="pal-box" role="dialog" aria-label="Command palette"><input placeholder="Type a command or search tasks..." aria-label="Command"><div class="pal-list"></div></div>';
  document.body.append(el);
  const input = $('input', el), list = $('.pal-list', el);
  let idx = 0, shown = cmds;
  const draw = () => {
    shown = cmds.filter((c) => c.t.toLowerCase().includes(input.value.toLowerCase()));
    idx = Math.min(idx, Math.max(0, shown.length - 1));
    list.innerHTML = shown.map((c, i) => `<button class="pal-item${i === idx ? ' on' : ''}" data-i="${i}"><span>${esc(c.t)}</span>${c.k ? `<kbd>${esc(c.k)}</kbd>` : ''}</button>`).join('') || '<div class="pal-empty">No matches</div>';
    list.querySelectorAll('.pal-item').forEach((b) => (b.onclick = () => go(Number(b.dataset.i))));
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => el.remove();
  const go = (i) => { const c = shown[i]; close(); c?.run(); };
  input.addEventListener('input', () => { idx = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, shown.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(idx); }
  });
  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  draw(); input.focus();
}
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); } });

// Keep elapsed timers and relative times fresh.
setInterval(() => {
  const t = taskOf(state.sel);
  if (t) for (const r of t.runs) if (r.status === 'running') syncHead(t, r);
}, 1000);
setInterval(renderList, 30000);

// ---------- boot ----------
(async function boot() {
  syncChips(); syncMode(); syncKind(); fillRecent(); syncModelLabel();
  await loadStatus();
  $('#repo').value = store('repo') || state.status?.cwd || '';
  checkRepo();
  state.tasks = await api('/api/tasks').catch(() => []);
  renderList(); renderTop(); renderStage();
  connect();
  setInterval(loadStatus, 60000);
})();
