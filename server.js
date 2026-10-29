#!/usr/bin/env node
// Duo: run Claude Code and Codex side by side on the same task, each in its own
// git worktree, using the official CLIs and their subscription logins.
// Zero dependencies. Binds to 127.0.0.1 only.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { adapters, parseLine, hintFor } = require('./lib/agents');
const team = require('./lib/team');
const gh = require('./lib/github');
const ci = require('./lib/ci');

const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';
const DATA_DIR = process.env.DUO_HOME || path.join(os.homedir(), '.duo');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const WORKTREES = path.join(DATA_DIR, 'worktrees');
const PUBLIC = path.join(__dirname, 'public');
const MAX_ITEMS = 4000;

fs.mkdirSync(WORKTREES, { recursive: true });

/** @type {Map<string, any>} */
const tasks = new Map();
const procs = new Map(); // `${taskId}:${agent}` -> child
const clients = new Set();

// ---------- persistence ----------
try {
  for (const t of JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))) {
    for (const r of t.runs) if (r.status === 'running' || r.status === 'queued') r.status = 'interrupted';
    tasks.set(t.id, t);
  }
} catch { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify([...tasks.values()]), () => {});
  }, 300);
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

// ---------- helpers ----------
// Agents run in their own process group so Stop also kills the shells and dev servers they started.
function killTree(child, sig = 'SIGTERM') {
  if (!child || child.exitCode !== null || !child.pid) return;
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
  setTimeout(() => { if (child.exitCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 4000).unref();
}
// git worktree/branch/merge operations on one repo must not interleave.
let gitChain = Promise.resolve();
const serial = (fn) => { const r = gitChain.then(fn, fn); gitChain = r.catch(() => {}); return r; };
const TURN_TIMEOUT_MS = Number(process.env.DUO_TURN_TIMEOUT_MIN || 45) * 60_000;
const authCache = new Map();
async function authCached(agent) {
  const hit = authCache.get(agent);
  if (hit && Date.now() - hit.t < 20_000) return hit.v;
  const v = await authStatus(agent);
  authCache.set(agent, { t: Date.now(), v });
  return v;
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);

function cleanEnv(agent) {
  const env = { ...process.env, NO_COLOR: '1', CI: '1' };
  // Force subscription auth: an API key in the environment would silently switch
  // the CLI to pay-per-token API billing.
  for (const k of adapters[agent].apiKeyVars) delete env[k];
  return env;
}

function leakedKeys() {
  const out = {};
  for (const [agent, a] of Object.entries(adapters)) {
    out[agent] = a.apiKeyVars.filter((k) => process.env[k]);
  }
  return out;
}

const dirIsEmpty = (d) => { try { return fs.readdirSync(d).length === 0; } catch { return false; } };

async function repoInfo(dir) {
  const abs = path.resolve(String(dir || '').replace(/^~(?=$|\/)/, os.homedir()));
  let stat;
  try { stat = fs.statSync(abs); } catch { return { path: abs, exists: false, git: false, empty: true }; }
  if (!stat.isDirectory()) return { path: abs, exists: false, git: false };
  try { fs.readdirSync(abs); } catch (e) {
    // macOS privacy (TCC) blocks apps from Documents, Desktop, Downloads until you allow them
    if (e.code === 'EPERM' || e.code === 'EACCES') return { path: abs, exists: true, git: false, blocked: true };
  }
  const top = await git(abs, 'rev-parse', '--show-toplevel');
  // An empty folder inside some other repo is a fresh project, not part of that repo.
  if (!top.ok || (path.resolve(top.stdout.trim()) !== abs && dirIsEmpty(abs))) return { path: abs, exists: true, git: false, empty: dirIsEmpty(abs) };
  const root = top.stdout.trim();
  const [dirty, head] = await Promise.all([git(root, 'status', '--porcelain'), git(root, 'rev-parse', '--verify', 'HEAD')]);
  // symbolic-ref also works before the first commit (unborn branch)
  const branch = await git(root, 'symbolic-ref', '--short', 'HEAD');
  const remote = await git(root, 'remote', 'get-url', 'origin');
  return {
    path: root, exists: true, git: true, hasCommits: head.ok, remote: remote.ok ? remote.stdout.trim() : null,
    branch: branch.stdout.trim() || 'main', dirty: dirty.stdout.trim().split('\n').filter(Boolean).length,
  };
}

async function initialCommit(dir) {
  const args = ['commit', '-q', '--allow-empty', '-m', 'Initial commit'];
  let r = await git(dir, ...args);
  if (!r.ok) r = await git(dir, '-c', 'user.name=Duo', '-c', 'user.email=duo@localhost', ...args); // no git identity yet
  if (!r.ok) throw httpErr(500, `Could not create the first commit: ${r.stderr.trim()}`);
}

// Starting from scratch: make a missing/empty folder, a fresh git repo or an empty clone workable.
async function ensureRepo(repo, initGit) {
  if (repo.blocked) {
    throw httpErr(403, `macOS is not letting Duo open ${repo.path}. Allow it once: System Settings > Privacy & Security > Full Disk Access, add Duo.app, then quit and reopen Duo.`, 'blocked');
  }
  if (!repo.exists) {
    try { fs.mkdirSync(repo.path, { recursive: true }); } catch (e) { throw httpErr(400, `Cannot create ${repo.path}: ${e.message}`); }
    repo = { ...repo, exists: true, empty: true };
  }
  if (!repo.git) {
    if (!repo.empty && !initGit) throw httpErr(409, `${repo.path} is not a git repository yet.`, 'needs_init');
    const r = await git(repo.path, 'init', '-q', '-b', 'main');
    if (!r.ok) throw httpErr(500, r.stderr.trim());
    if (!repo.empty) await git(repo.path, 'add', '-A');
    await initialCommit(repo.path);
    return { ...(await repoInfo(repo.path)), fresh: true };
  }
  if (!repo.hasCommits) { await initialCommit(repo.path); return { ...(await repoInfo(repo.path)), fresh: true }; }
  return repo;
}

async function authStatus(agent) {
  const a = adapters[agent];
  const bin = a.bin();
  const r = await run(bin, a.statusArgs, { env: cleanEnv(agent), timeout: 8000 });
  if (r.code === 'ENOENT') return { installed: false, loggedIn: false, detail: `${a.label} CLI not found` };
  return { installed: true, ...a.parseStatus(r) };
}

// ---------- task lifecycle ----------
function pushItem(task, run, item) {
  item.t = Date.now();
  if (item.kind === 'error' && !item.hint) item.hint = hintFor(item.text);
  if (run.items.length < MAX_ITEMS) run.items.push(item);
  broadcast({ type: 'item', taskId: task.id, agent: run.agent, item });
  save();
}
function setStatus(task, run, status, extra = {}) {
  run.status = status;
  Object.assign(run, extra);
  broadcast({ type: 'status', taskId: task.id, agent: run.agent, status, extra });
  save();
}

const changedOf = async (dir) =>
  (await git(dir, 'status', '--porcelain', '--', '.', team.EXCLUDE)).stdout.split('\n').filter(Boolean);

// Compete mode: one isolated worktree per agent.
async function startRun(task, run) {
  setStatus(task, run, 'running', { startedAt: Date.now() });

  const repo = await repoInfo(task.repo);
  const branch = `duo/${task.id}-${run.agent}`;
  const dir = path.join(WORKTREES, `${task.id}-${run.agent}`);
  const wt = await serial(() => git(repo.path, 'worktree', 'add', '-b', branch, dir, 'HEAD'));
  if (!wt.ok) {
    pushItem(task, run, { kind: 'error', text: `Could not create worktree: ${wt.stderr.trim()}` });
    return setStatus(task, run, 'failed', { endedAt: Date.now() });
  }
  run.dir = dir; run.branch = branch; run.repoRoot = repo.path;
  broadcast({ type: 'status', taskId: task.id, agent: run.agent, status: 'running', extra: { branch } });
  pushItem(task, run, { kind: 'meta', text: `${adapters[run.agent].label} started in isolated branch ${branch}` });
  launch(task, run, task.ci ? `${task.prompt}\n\n${task.ci}` : task.prompt);
}

// One agent turn: spawn the CLI in run.dir with the prompt on stdin.
function launch(task, run, prompt) {
  const a = adapters[run.agent];
  run.turns = (run.turns || 0) + 1;
  const { args, input } = a.build({ prompt, mode: task.mode, dir: run.dir, model: task.models?.[run.agent] });

  const child = spawn(a.bin(), args, { cwd: run.dir, env: cleanEnv(run.agent), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  procs.set(`${task.id}:${run.agent}`, child);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, TURN_TIMEOUT_MS);
  child.stdin.on('error', () => {});
  child.stdin.end(input);

  let buf = '';
  const state = {};
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(task, run, line, state);
    }
  });
  let errBuf = '';
  child.stderr.on('data', (c) => { errBuf = (errBuf + c).slice(-4000); });
  child.on('error', (e) => {
    clearTimeout(timer);
    pushItem(task, run, { kind: 'error', text: e.code === 'ENOENT' ? `${a.label} CLI not found on PATH` : e.message });
    setStatus(task, run, 'failed', { endedAt: Date.now() });
  });
  child.on('close', async (code, signal) => {
    clearTimeout(timer);
    procs.delete(`${task.id}:${run.agent}`);
    if (buf.trim()) handleLine(task, run, buf.trim(), state);
    if (run.status === 'cancelled') return;
    if (timedOut) pushItem(task, run, { kind: 'error', text: `Stopped: this turn ran longer than ${TURN_TIMEOUT_MS / 60000} minutes.` });
    else if (code !== 0 && errBuf.trim()) pushItem(task, run, { kind: 'error', text: errBuf.trim() });
    const changed = (await changedOf(run.dir)).length;
    const failed = code !== 0 || state.failed;
    setStatus(task, run, failed ? 'failed' : 'done', { endedAt: Date.now(), changed: task.team ? undefined : changed, exitCode: code, signal, turns: run.turns });
    if (task.team) {
      task.team.changed = changed;
      broadcast({ type: 'team', taskId: task.id, team: { changed } });
      pump(task);
    }
  });
}

function handleLine(task, run, line, state) {
  const items = parseLine(run.agent, line, state);
  for (const it of items) {
    if (it.files) it.files = it.files.map((f) => (path.isAbsolute(f) && run.dir ? path.relative(run.dir, f) : f)).filter((f) => f && !f.startsWith('..') && !f.startsWith('.duo'));
    if (it.kind === 'usage') {
      run.usage = { ...(run.usage || {}), ...it.usage };
      broadcast({ type: 'usage', taskId: task.id, agent: run.agent, usage: run.usage });
      save();
    } else pushItem(task, run, it);
  }
}

// ---------- team mode ----------
function syncMessages(task) {
  let raw;
  try { raw = fs.readFileSync(path.join(task.team.dir, '.duo', 'messages.jsonl'), 'utf8'); } catch { return false; }
  const lines = raw.split('\n').filter(Boolean);
  let added = false;
  for (let i = task.team.messages.length; i < lines.length; i++) {
    let m;
    try { m = JSON.parse(lines[i]); } catch { m = { from: 'system', to: 'you', text: '(unreadable message)', ts: Date.now() }; }
    m.id = i;
    task.team.messages.push(m);
    broadcast({ type: 'message', taskId: task.id, msg: m });
    added = true;
  }
  if (added) save();
  return added;
}

// Starts a follow-up turn for any idle agent that has unread messages.
function pump(task) {
  if (!task.team || task.team.applied || task.team.discarded) return;
  syncMessages(task);
  for (const run of task.runs) {
    if (run.status === 'running') continue;
    const pending = task.team.messages.filter((m) => m.id >= (run.cursor || 0) && m.to === run.agent);
    if (!run.started) { startTurn(task, run, pending); continue; }
    if (!pending.length) continue;
    const human = pending.some((m) => m.from === 'you');
    if (!human && (run.status === 'cancelled' || run.status === 'failed' || run.status === 'interrupted')) continue;
    if (!human && (run.turns || 0) >= team.MAX_TURNS) {
      if (!run.capNoted) {
        run.capNoted = true;
        pushItem(task, run, { kind: 'meta', text: `Turn limit (${team.MAX_TURNS}) reached - not resuming for new messages` });
      }
      continue;
    }
    startTurn(task, run, pending);
  }
}

async function startTurn(task, run, pending) {
  setStatus(task, run, 'running', { startedAt: run.startedAt || Date.now(), endedAt: null, turns: (run.turns || 0) + 1 });
  run.started = true;
  run.turns -= 1; // launch() does the real increment
  run.cursor = task.team.messages.length;
  run.capNoted = false;
  const turn = (run.turns || 0) + 1;
  if (turn > 1) {
    const from = [...new Set(pending.map((m) => (m.from === 'you' ? 'you' : team.LABEL[m.from])))].join(', ');
    pushItem(task, run, { kind: 'meta', text: `Turn ${turn} - ${pending.length} new message${pending.length > 1 ? 's' : ''} from ${from}` });
  } else {
    pushItem(task, run, { kind: 'meta', text: `${adapters[run.agent].label} joined the team: ${task.team.roles[run.agent]}` });
  }
  const files = (await changedOf(run.dir)).map((l) => l.slice(3));
  launch(task, run, team.buildPrompt({ agent: run.agent, goal: task.prompt, roles: task.team.roles, turn, pending, changedFiles: files, ci: task.ci }));
}

async function createTeamTask(task, repo, body) {
  const branch = `duo/${task.id}-team`;
  const dir = path.join(WORKTREES, `${task.id}-team`);
  const wt = await serial(() => git(repo.path, 'worktree', 'add', '-b', branch, dir, 'HEAD'));
  if (!wt.ok) throw httpErr(500, `Could not create worktree: ${wt.stderr.trim()}`);
  team.setupTeamDir(dir);
  const r = body.roles || {};
  task.team = {
    dir, branch, messages: [], changed: 0,
    roles: {
      claude: String(r.claude || '').trim() || 'Backend: server logic, APIs, data layer, tests for them',
      codex: String(r.codex || '').trim() || 'Frontend: UI, components, styling, client-side logic',
    },
  };
  for (const run of task.runs) { run.dir = dir; run.branch = branch; run.repoRoot = repo.path; }
}

async function postMessage(task, to, text) {
  if (!task.team || task.team.applied || task.team.discarded) throw httpErr(400, 'This team is closed');
  text = String(text || '').trim();
  if (!text) throw httpErr(400, 'Message is empty');
  const targets = to === 'all' ? ['claude', 'codex'] : [to];
  if (!targets.every((x) => x === 'claude' || x === 'codex')) throw httpErr(400, 'Unknown recipient');
  for (const t of targets) team.appendMessage(task.team.dir, { from: 'you', to: t, text, ts: Date.now() });
  pump(task);
}

setInterval(() => {
  for (const t of tasks.values()) {
    if (t.team && !t.team.applied && !t.team.discarded && t.runs.some((r) => r.status === 'running')) {
      if (syncMessages(t)) pump(t);
    }
  }
}, 600);

// Model ids go to the CLI as a single argv value; keep them plain and never let one look like a flag.
function cleanModels(m) {
  const out = {};
  for (const a of Object.keys(adapters)) {
    const v = String(m?.[a] ?? '').trim();
    if (!v) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:\[\]/-]{0,79}$/.test(v)) throw httpErr(400, `Invalid model name for ${adapters[a].label}: "${v.slice(0, 40)}"`);
    out[a] = v;
  }
  return out;
}

function newId() { return crypto.randomBytes(3).toString('hex'); }

async function createTask(body) {
  const prompt = String(body.prompt || '').trim();
  if (!prompt) throw httpErr(400, 'Prompt is required');
  const agents = body.kind === 'team' ? ['claude', 'codex'] : (body.agents || []).filter((x) => adapters[x]);
  if (!agents.length) throw httpErr(400, 'Pick at least one agent');
  for (const a of agents) {
    const st = await authCached(a);
    if (!st.installed) throw httpErr(400, `${adapters[a].label} CLI is not installed on this machine.`);
    if (!st.loggedIn) throw httpErr(400, `${adapters[a].label} is not signed in. Use the Sign in button in the sidebar first.`);
  }
  if (!String(body.repo || '').trim()) throw httpErr(400, 'Choose a project folder first');
  const repo = await ensureRepo(await repoInfo(body.repo), body.initGit === true);
  const isTeam = body.kind === 'team';
  const task = {
    id: newId(), prompt, repo: repo.path, remote: repo.remote, fresh: !!repo.fresh, ci: isTeam || body.mode !== 'review' ? ci.ciSection(repo.path) : '', mode: isTeam || body.mode !== 'review' ? 'build' : 'review',
    models: cleanModels(body.models), createdAt: Date.now(), baseBranch: repo.branch,
    runs: agents.map((agent) => ({ agent, status: 'queued', items: [], cursor: 0 })),
  };
  if (isTeam) await createTeamTask(task, repo, body);
  tasks.set(task.id, task);
  save();
  broadcast({ type: 'task', task });
  if (isTeam) pump(task); else for (const r of task.runs) startRun(task, r);
  return task;
}

function findRun(taskId, agent) {
  const task = tasks.get(taskId);
  const run = task && task.runs.find((r) => r.agent === agent);
  if (!run) throw httpErr(404, 'Not found');
  return { task, run };
}

async function diffOf(run) {
  if (!run.dir || !fs.existsSync(run.dir)) return { diff: '', stat: '' };
  await git(run.dir, 'add', '-A', '--', '.', team.EXCLUDE);
  const [diff, stat] = await Promise.all([
    git(run.dir, 'diff', '--cached', 'HEAD', '--no-color', '--', '.', team.EXCLUDE),
    git(run.dir, 'diff', '--cached', 'HEAD', '--stat', '--no-color', '--', '.', team.EXCLUDE),
  ]);
  return { diff: diff.stdout.slice(0, 2_000_000), stat: stat.stdout };
}

async function commitRun(task, run) {
  if (!run.dir) throw httpErr(400, 'Nothing to commit');
  await git(run.dir, 'add', '-A', '--', '.', team.EXCLUDE);
  const who = task.team ? 'Duo team' : adapters[run.agent].label;
  const c = await git(run.dir, '-c', 'user.name=Duo', '-c', 'user.email=duo@localhost',
    'commit', '-m', `${who}: ${task.prompt.split('\n')[0].slice(0, 70)}`);
  if (!c.ok && !/nothing to commit/.test(c.stdout + c.stderr)) throw httpErr(500, c.stderr || c.stdout);
}

async function prRun(task, run) {
  await commitRun(task, run);
  const who = task.team ? 'Claude Code and Codex (team)' : adapters[run.agent].label;
  const files = (await git(run.dir, 'diff', '--stat', `${task.baseBranch}...HEAD`)).stdout.trim();
  const { url } = await gh.openPullRequest({
    repoRoot: run.repoRoot, branch: run.branch, base: task.baseBranch,
    title: task.prompt.split('\n')[0],
    body: `${task.prompt}\n\n---\nWritten by ${who} using Duo.\n\n\`\`\`\n${files}\n\`\`\``,
  });
  if (task.team) { task.team.prUrl = url; broadcast({ type: 'team', taskId: task.id, team: { prUrl: url } }); }
  else { run.prUrl = url; broadcast({ type: 'status', taskId: task.id, agent: run.agent, status: run.status, extra: { prUrl: url } }); }
  save();
  return url;
}

async function applyRun(task, run) {
  await commitRun(task, run);
  const m = await serial(() => git(run.repoRoot, 'merge', '--no-ff', '--no-edit', run.branch));
  if (!m.ok) {
    await git(run.repoRoot, 'merge', '--abort');
    throw httpErr(409, `Merge failed (nothing was changed): ${(m.stderr || m.stdout).trim()}`);
  }
  if (task.team) {
    task.team.applied = true;
    broadcast({ type: 'team', taskId: task.id, team: { applied: true } });
    save();
    return;
  }
  run.applied = true;
  broadcast({ type: 'status', taskId: task.id, agent: run.agent, status: run.status, extra: { applied: true } });
  save();
}

async function discardTeam(task) {
  for (const r of task.runs) killTree(procs.get(`${task.id}:${r.agent}`));
  const r = task.runs[0];
  await serial(async () => {
    await git(r.repoRoot, 'worktree', 'remove', '--force', task.team.dir);
    await git(r.repoRoot, 'branch', '-D', task.team.branch);
  });
  task.team.discarded = true;
  broadcast({ type: 'team', taskId: task.id, team: { discarded: true } });
  save();
}

async function discardRun(task, run) {
  killTree(procs.get(`${task.id}:${run.agent}`));
  if (run.dir) {
    await serial(async () => {
      await git(run.repoRoot, 'worktree', 'remove', '--force', run.dir);
      await git(run.repoRoot, 'branch', '-D', run.branch);
    });
  }
  run.discarded = true;
  broadcast({ type: 'status', taskId: task.id, agent: run.agent, status: run.status, extra: { discarded: true } });
  save();
}

// ---------- HTTP ----------
function httpErr(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(httpErr(413, 'Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(httpErr(400, 'Bad JSON')); } });
  });
}

// Anything that can run commands must not be reachable from other websites or
// via DNS rebinding.
function originOk(req) {
  const allowed = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
  if (!allowed.has(String(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (origin && !allowed.has(origin.replace(/^https?:\/\//, ''))) return false;
  return true;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  try {
    if (!originOk(req)) return json(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, `http://${HOST}`);
    const p = url.pathname;

    if (req.method === 'GET' && !p.startsWith('/api/')) {
      const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }

    if (p === '/api/ping') return json(res, 200, { ok: true }); // cheap liveness check for the Mac app launcher

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }

    if (req.method === 'GET' && p === '/api/status') {
      const [claude, codex] = await Promise.all([authStatus('claude'), authStatus('codex')]);
      const github = await gh.status();
      return json(res, 200, { claude, codex, github, strippedEnv: leakedKeys(), cwd: process.cwd(), home: os.homedir() });
    }
    let m;
    if (req.method === 'GET' && p === '/api/github') return json(res, 200, { ...(await gh.status()), login: gh.loginState(), defaultDir: gh.DEFAULT_DIR() });
    if (req.method === 'POST' && p === '/api/github/login') { gh.forget(); return json(res, 200, gh.startLogin()); }
    if (req.method === 'GET' && p === '/api/github/repos') return json(res, 200, await gh.listRepos(url.searchParams.get('dir')));
    if (req.method === 'POST' && p === '/api/projects/clone') { const b = await readBody(req); return json(res, 200, await gh.cloneRepo(b.repo, b.dir)); }
    if (req.method === 'POST' && p === '/api/projects/create') return json(res, 200, await gh.createProject(await readBody(req)));
    if (req.method === 'POST' && (m = p.match(/^\/api\/tasks\/([a-f0-9]+)\/push$/))) {
      const task = tasks.get(m[1]);
      if (!task) throw httpErr(404, 'Not found');
      await gh.pushBranch(task.runs[0].repoRoot, task.baseBranch);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/repo') return json(res, 200, await repoInfo(url.searchParams.get('path')));
    if (req.method === 'GET' && p === '/api/tasks') return json(res, 200, [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt));
    if (req.method === 'POST' && p === '/api/tasks') return json(res, 200, await createTask(await readBody(req)));

    if (req.method === 'POST' && (m = p.match(/^\/api\/login\/(claude|codex)$/))) {
      // Opens the CLI's own browser sign-in flow on this machine.
      const a = adapters[m[1]];
      const child = spawn(a.bin(), a.loginArgs, { env: cleanEnv(m[1]), stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
      authCache.clear();
      return json(res, 200, { started: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/login\/(claude|codex)\/logout$/))) {
      const a = adapters[m[1]];
      await run(a.bin(), a.logoutArgs, { env: cleanEnv(m[1]) });
      authCache.clear();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/tasks\/([a-f0-9]+)\/message$/))) {
      const task = tasks.get(m[1]);
      if (!task) throw httpErr(404, 'Not found');
      const b = await readBody(req);
      await postMessage(task, b.to || 'all', b.text);
      return json(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/api\/tasks\/([a-f0-9]+)\/(claude|codex|team)\/(diff|apply|cancel|discard|pr)$/))) {
      if (m[2] === 'team') {
        const task = tasks.get(m[1]);
        if (!task || !task.team) throw httpErr(404, 'Not found');
        if (m[3] === 'diff' && req.method === 'GET') return json(res, 200, task.team.discarded ? { diff: '', stat: '' } : await diffOf(task.runs[0]));
        if (req.method !== 'POST') throw httpErr(405, 'Method not allowed');
        if (m[3] === 'apply') { await applyRun(task, task.runs[0]); return json(res, 200, { ok: true }); }
        if (m[3] === 'pr') return json(res, 200, { url: await prRun(task, task.runs[0]) });
        if (m[3] === 'discard') { await discardTeam(task); return json(res, 200, { ok: true }); }
        throw httpErr(404, 'Not found');
      }
      const { task, run: r } = findRun(m[1], m[2]);
      if (m[3] === 'diff' && req.method === 'GET') return json(res, 200, await diffOf(r));
      if (req.method !== 'POST') throw httpErr(405, 'Method not allowed');
      if (m[3] === 'cancel') {
        const child = procs.get(`${task.id}:${r.agent}`);
        if (child) { r.status = 'cancelled'; killTree(child); setStatus(task, r, 'cancelled', { endedAt: Date.now() }); }
        return json(res, 200, { ok: true });
      }
      if (m[3] === 'apply') { await applyRun(task, r); return json(res, 200, { ok: true }); }
      if (m[3] === 'pr') return json(res, 200, { url: await prRun(task, r) });
      if (m[3] === 'discard') { await discardRun(task, r); return json(res, 200, { ok: true }); }
    }

    if (req.method === 'DELETE' && (m = p.match(/^\/api\/tasks\/([a-f0-9]+)$/))) {
      const task = tasks.get(m[1]);
      if (!task) throw httpErr(404, 'Not found');
      if (task.team) { if (!task.team.discarded) await discardTeam(task); }
      else for (const r of task.runs) if (!r.discarded) await discardRun(task, r);
      tasks.delete(task.id);
      save();
      broadcast({ type: 'deleted', taskId: task.id });
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, e.status || 500, { error: e.message, code: typeof e.code === 'string' ? e.code : undefined });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Duo is running at http://localhost:${PORT}\n`);
});

function shutdown() {
  for (const c of procs.values()) killTree(c);
  try { fs.writeFileSync(STATE_FILE, JSON.stringify([...tasks.values()])); } catch { /* best effort */ }
  setTimeout(() => process.exit(0), 150);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));
