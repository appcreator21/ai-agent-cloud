'use strict';
// Integration tests: boot the real server against the fake CLIs in test/fake.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLine, hintFor } = require('../lib/agents');

const ROOT = path.join(__dirname, '..');
const PORT = 4500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-it-'));
const repo = path.join(tmp, 'repo');
let server;

const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(BASE + p).then((r) => r.json());
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
async function waitFor(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(120); }
}
const taskById = async (id) => (await get('/api/tasks')).find((t) => t.id === id);
const idle = (t) => t.runs.every((r) => ['done', 'failed', 'cancelled'].includes(r.status));

function freshRepo() {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  sh(repo, 'add', '.');
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
}

before(async () => {
  freshRepo();
  server = spawn('node', ['server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), DUO_HOME: path.join(tmp, 'home'), DUO_CLAUDE_BIN: path.join(ROOT, 'test/fake/claude'), DUO_CODEX_BIN: path.join(ROOT, 'test/fake/codex'), DUO_MAX_TURNS: '4', DUO_GH_BIN: path.join(ROOT, 'test/fake/gh'), FAKE_GH_REMOTES: path.join(tmp, 'remotes'), DUO_PROJECTS: path.join(tmp, 'projects') },
  });
  await waitFor(() => fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false), 8000, 'server');
});
after(async () => {
  const exited = new Promise((r) => server.on('exit', r));
  server.kill('SIGTERM');
  await exited;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('parsers map CLI events to feed items', () => {
  const c = parseLine('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Write', input: { file_path: '/x/y.js' } }] } }), {});
  assert.equal(c[0].kind, 'tool'); assert.deepEqual(c[0].files, ['/x/y.js']);
  const x = parseLine('codex', JSON.stringify({ type: 'item.completed', item: { id: '1', type: 'file_change', changes: [{ path: 'a.js', kind: 'add' }] } }), {});
  assert.deepEqual(x[0].files, ['a.js']);
  const st = {}; parseLine('codex', JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }), st);
  assert.equal(st.failed, true);
  assert.equal(parseLine('claude', 'not json', {})[0].kind, 'raw');
  assert.equal(hintFor('You hit your usage limit'), 'limit');
  assert.equal(hintFor('please log in'), 'auth');
});

test('rejects foreign Host and Origin', async () => {
  assert.equal((await fetch(BASE + '/api/tasks', { headers: { Origin: 'http://evil.com' } })).status, 403);
  const r = await new Promise((res) => require('node:http').get({ host: '127.0.0.1', port: PORT, path: '/api/tasks', headers: { Host: 'evil.com' } }, res));
  assert.equal(r.statusCode, 403);
  r.resume();
});

test('compete: both agents finish, files tracked, apply merges, conflicting apply aborts cleanly', async () => {
  const r = await post('/api/tasks', { prompt: 'add a greeting', repo, agents: ['claude', 'codex'] });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  const t = await waitFor(async () => { const x = await taskById(id); return idle(x) && x; }, 15000, 'compete done');
  assert.deepEqual(t.runs.map((x) => x.status), ['done', 'done']);
  assert.ok(t.runs[0].items.some((i) => i.files?.includes('hello.txt')), 'claude file tracked');
  assert.ok(t.runs[1].items.some((i) => i.files?.includes('hello.txt')), 'codex file tracked');
  assert.equal((await post(`/api/tasks/${id}/claude/apply`)).status, 200);
  assert.match(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), /Claude/);
  const bad = await post(`/api/tasks/${id}/codex/apply`);
  assert.equal(bad.status, 409);
  assert.equal(sh(repo, 'status', '--porcelain').trim(), '', 'repo left clean after failed merge');
  assert.equal((await post(`/api/tasks/${id}/codex/discard`)).status, 200);
});

test('rejects empty prompt, non-git repo, and unknown agents', async () => {
  assert.equal((await post('/api/tasks', { prompt: '', repo, agents: ['claude'] })).status, 400);
  const nonGit = await post('/api/tasks', { prompt: 'x', repo: tmp, agents: ['claude'] });
  assert.equal(nonGit.status, 409); assert.equal((await nonGit.json()).code, 'needs_init'); // existing files: ask before touching
  assert.equal((await post('/api/tasks', { prompt: 'x', repo, agents: ['gpt'] })).status, 400);
});

test('team: agents message each other, get re-woken, share one diff, apply merges', async () => {
  freshRepo();
  const r = await post('/api/tasks', { kind: 'team', prompt: 'Build a todo app', repo, roles: { claude: 'Backend', codex: 'Frontend' } });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  const t = await waitFor(async () => {
    const x = await taskById(id);
    return idle(x) && x.team.messages.length >= 3 && x.runs.every((q) => q.turns >= 1) && x;
  }, 25000, 'team conversation');
  const pairs = t.team.messages.map((m) => `${m.from}>${m.to}`);
  assert.ok(pairs.includes('claude>codex') && pairs.includes('codex>claude'), 'two-way talk: ' + pairs);
  assert.ok(t.runs[0].turns >= 2, 'claude was re-woken by codex message');
  const d = await get(`/api/tasks/${id}/team/diff`);
  assert.match(d.diff, /server\/todos\.js/); assert.match(d.diff, /web\/index\.html/);
  assert.doesNotMatch(d.diff, /\.duo/, 'mailbox excluded from diff');

  // a human message wakes an idle agent
  const before = t.runs[1].turns;
  assert.equal((await post(`/api/tasks/${id}/message`, { to: 'codex', text: 'also add a footer' })).status, 200);
  await waitFor(async () => { const x = await taskById(id); return x.runs[1].turns > before && idle(x); }, 15000, 'human wake');

  assert.equal((await post(`/api/tasks/${id}/team/apply`)).status, 200);
  assert.ok(fs.existsSync(path.join(repo, 'server/todos.js')) && fs.existsSync(path.join(repo, 'web/index.html')));
  assert.ok(!fs.existsSync(path.join(repo, '.duo')), 'mailbox not merged into repo');
  assert.match(sh(repo, 'log', '--oneline', '-3'), /Duo team/);
  assert.equal((await post(`/api/tasks/${id}/message`, { to: 'all', text: 'late' })).status, 400, 'closed team rejects messages');
});

test('cancel kills a running agent promptly', async () => {
  freshRepo();
  const { id } = await (await post('/api/tasks', { prompt: 'SLOW task', repo, agents: ['claude'] })).json();
  await waitFor(async () => (await taskById(id)).runs[0].items.some((i) => i.text === 'working slowly'), 8000, 'slow start');
  assert.equal((await post(`/api/tasks/${id}/claude/cancel`)).status, 200);
  const t = await waitFor(async () => { const x = await taskById(id); return x.runs[0].status === 'cancelled' && x; }, 5000, 'cancelled');
  assert.equal(t.runs[0].status, 'cancelled');
  await post(`/api/tasks/${id}/claude/discard`);
});

test('delete task removes worktrees and branches', async () => {
  freshRepo();
  const { id } = await (await post('/api/tasks', { prompt: 'x', repo, agents: ['codex'] })).json();
  await waitFor(async () => idle(await taskById(id)), 15000, 'done');
  assert.match(sh(repo, 'branch'), new RegExp(`duo/${id}-codex`));
  await fetch(`${BASE}/api/tasks/${id}`, { method: 'DELETE' });
  assert.doesNotMatch(sh(repo, 'branch'), new RegExp(`duo/${id}`));
});

test('missing CLI gives a clear error', async () => {
  const port = PORT + 400;
  const s = spawn('node', ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(port), DUO_HOME: path.join(tmp, 'home2'), DUO_CLAUDE_BIN: '/nonexistent/claude' } });
  try {
    await waitFor(() => fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.ok).catch(() => false), 8000, 'server2');
    const r = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', repo, agents: ['claude'] }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /not installed/);
  } finally { s.kill('SIGTERM'); }
});

test('github: status, device-code login, repo list', async () => {
  const st = await get('/api/github');
  assert.equal(st.loggedIn, true); assert.equal(st.user, 'matt');
  const l = await (await post('/api/github/login')).json();
  const code = await waitFor(async () => (await get('/api/github')).login?.code, 5000, 'device code');
  assert.equal(code, 'ABCD-1234');
  await waitFor(async () => (await get('/api/github')).login?.done, 5000, 'login done');
  assert.equal((await get('/api/github')).login.error, null);
  const repos = await get('/api/github/repos');
  assert.deepEqual(repos.map((r) => r.nameWithOwner), ['matt/todo-app', 'matt/site']);
  assert.equal(repos[0].local, null);
});

test('github: clone then reuse, and name validation', async () => {
  const r = await (await post('/api/projects/clone', { repo: 'matt/todo-app' })).json();
  assert.ok(fs.existsSync(path.join(r.path, '.git')) && r.existed === false);
  assert.equal((await (await post('/api/projects/clone', { repo: 'matt/todo-app' })).json()).existed, true);
  assert.equal((await get('/api/github/repos'))[0].local, r.path);
  assert.equal((await post('/api/projects/clone', { repo: '../../etc/passwd' })).status, 400);
  assert.equal((await post('/api/projects/create', { name: '../evil', github: false })).status, 400);
  assert.equal((await post('/api/projects/create', { name: 'has space', github: false })).status, 400);
});

test('github: create a repo (local only, then on GitHub), open a PR, push', async () => {
  const local = await (await post('/api/projects/create', { name: 'local-only', github: false })).json();
  assert.equal((await get('/api/repo?path=' + encodeURIComponent(local.path))).remote, null);
  assert.equal((await post('/api/tasks/zzz/team/pr')).status, 404);

  const c = await (await post('/api/projects/create', { name: 'my-new-app', visibility: 'private', description: 'hello', github: true })).json();
  assert.equal(c.github, true); assert.match(c.url, /github\.com\/matt\/my-new-app/);
  const info = await get('/api/repo?path=' + encodeURIComponent(c.path));
  assert.ok(info.remote && info.hasCommits && info.branch === 'main');
  assert.equal((await post('/api/projects/create', { name: 'my-new-app', github: true })).status, 409);

  const { id } = await (await post('/api/tasks', { prompt: 'add a greeting', repo: c.path, agents: ['claude'] })).json();
  await waitFor(async () => idle(await taskById(id)), 15000, 'run done');
  const pr = await (await post(`/api/tasks/${id}/claude/pr`)).json();
  assert.match(pr.url, /pull\/7/);
  const bare = path.join(tmp, 'remotes', 'my-new-app.git');
  assert.match(sh(bare, 'branch'), new RegExp(`duo/${id}-claude`), 'branch pushed to remote');
  assert.equal((await taskById(id)).runs[0].prUrl, pr.url);

  assert.equal((await post(`/api/tasks/${id}/claude/apply`)).status, 200);
  assert.equal((await post(`/api/tasks/${id}/push`)).status, 200);
  assert.match(sh(bare, 'log', '--oneline', 'main'), /Claude Code/, 'main pushed with the merged work');
});

test('from scratch: empty git repo, missing folder and empty folder all just work', async () => {
  // git init with zero commits
  const bare0 = path.join(tmp, 'scratch1'); fs.mkdirSync(bare0); sh(bare0, 'init', '-q', '-b', 'main');
  assert.equal((await get('/api/repo?path=' + encodeURIComponent(bare0))).hasCommits, false);
  let r = await post('/api/tasks', { prompt: 'build it', repo: bare0, agents: ['claude'] });
  assert.equal(r.status, 200);
  let t = await r.json(); assert.equal(t.fresh, true); assert.equal(t.baseBranch, 'main');
  await waitFor(async () => idle(await taskById(t.id)), 15000, 'scratch1 done');
  assert.match(sh(bare0, 'log', '--oneline'), /Initial commit/);
  assert.equal((await post(`/api/tasks/${t.id}/claude/apply`)).status, 200);
  assert.ok(fs.existsSync(path.join(bare0, 'hello.txt')));

  // folder that does not exist yet (created + git init)
  const fresh = path.join(tmp, 'does', 'not', 'exist');
  r = await post('/api/tasks', { kind: 'team', prompt: 'new app', repo: fresh, roles: { claude: 'Backend', codex: 'Frontend' } });
  assert.equal(r.status, 200); t = await r.json();
  assert.ok(fs.existsSync(path.join(fresh, '.git')));
  await waitFor(async () => { const x = await taskById(t.id); return idle(x) && x.team.messages.length >= 2; }, 25000, 'team in new folder');

  // empty folder nested inside another repo is its own project, not part of the parent
  const nested = path.join(repo, 'child'); fs.mkdirSync(nested, { recursive: true });
  const info = await get('/api/repo?path=' + encodeURIComponent(nested));
  assert.equal(info.git, false); assert.equal(info.empty, true);

  // non-empty non-git folder: refused until the user agrees, then committed as-is
  const existing = path.join(tmp, 'existing'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'a.txt'), 'keep me\n');
  assert.equal((await post('/api/tasks', { prompt: 'x', repo: existing, agents: ['codex'] })).status, 409);
  r = await post('/api/tasks', { prompt: 'x', repo: existing, agents: ['codex'], initGit: true });
  assert.equal(r.status, 200); t = await r.json();
  await waitFor(async () => idle(await taskById(t.id)), 15000, 'existing done');
  assert.match(sh(existing, 'ls-files'), /a\.txt/);
});

test('empty GitHub remote: PR explains what to do, Apply + Push publishes the branch, then PR works', async () => {
  const dir = path.join(tmp, 'projects', 'empty-remote'); fs.mkdirSync(dir, { recursive: true });
  const bare = path.join(tmp, 'remotes', 'empty-remote.git'); fs.mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'remote', 'add', 'origin', bare);
  const { id } = await (await post('/api/tasks', { prompt: 'first feature', repo: dir, agents: ['claude'] })).json();
  await waitFor(async () => idle(await taskById(id)), 15000, 'done');
  const early = await post(`/api/tasks/${id}/claude/pr`);
  assert.equal(early.status, 400); assert.match((await early.json()).error, /no "main" branch yet/);
  assert.equal((await post(`/api/tasks/${id}/claude/apply`)).status, 200);
  assert.equal((await post(`/api/tasks/${id}/push`)).status, 200);
  assert.match(sh(bare, 'branch'), /main/);
  const again = await post(`/api/tasks/${id}/claude/pr`);
  assert.equal(again.status, 200);
});
