'use strict';
// GitHub integration through the official `gh` CLI. Duo never sees or stores a
// token: gh keeps the login and `gh auth setup-git` lets plain `git push` use it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const GH = () => process.env.DUO_GH_BIN || 'gh';
const DEFAULT_DIR = () => process.env.DUO_PROJECTS || path.join(os.homedir(), 'DuoProjects');
const env = () => ({ ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: '', NO_COLOR: '1' });

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: env(), ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
const git = (cwd, ...a) => run('git', ['-C', cwd, ...a]);

const expand = (p) => path.resolve(String(p || '').replace(/^~(?=$|\/)/, os.homedir()));
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

let statusCache = null;
async function status() {
  if (statusCache && Date.now() - statusCache.t < 15000) return statusCache.v;
  const r = await run(GH(), ['auth', 'status', '--hostname', 'github.com'], { timeout: 8000 });
  let v;
  if (r.code === 'ENOENT') v = { installed: false, loggedIn: false };
  else if (!r.ok) v = { installed: true, loggedIn: false };
  else {
    const u = await run(GH(), ['api', 'user', '-q', '.login'], { timeout: 8000 });
    v = { installed: true, loggedIn: true, user: u.stdout.trim() };
  }
  statusCache = { t: Date.now(), v };
  return v;
}
const forget = () => { statusCache = null; };

// ---- device-code sign in: gh prints a one-time code, the human enters it in the browser ----
let login = null;
function startLogin() {
  if (login && !login.done) return login;
  const st = (login = { code: null, done: false, error: null });
  let out = '', pressed = false;
  const child = spawn(GH(), ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
  const onData = (c) => {
    out = (out + c).slice(-4000);
    const m = out.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
    if (m) st.code = m[1];
    if (!pressed && /press enter/i.test(out)) { pressed = true; try { child.stdin.write('\n'); } catch { /* closed */ } }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000);
  child.on('error', (e) => { clearTimeout(timer); st.done = true; st.error = e.code === 'ENOENT' ? 'The GitHub CLI (gh) is not installed.' : e.message; });
  child.on('close', async (code) => {
    clearTimeout(timer);
    st.done = true;
    if (code === 0) await run(GH(), ['auth', 'setup-git'], { timeout: 10000 });
    else st.error = st.error || 'Sign-in did not complete.';
    forget();
  });
  return st;
}
const loginState = () => login && { code: login.code, done: login.done, error: login.error };

async function listRepos(baseDir) {
  const r = await run(GH(), ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,description,isPrivate,pushedAt'], { timeout: 30000 });
  if (!r.ok) throw fail(502, (r.stderr || 'Could not list repositories').trim());
  const dir = expand(baseDir || DEFAULT_DIR());
  return JSON.parse(r.stdout || '[]').map((x) => {
    const local = path.join(dir, x.nameWithOwner.split('/')[1]);
    return { ...x, local: fs.existsSync(path.join(local, '.git')) ? local : null };
  });
}

async function cloneRepo(slug, baseDir) {
  if (!SLUG_RE.test(String(slug))) throw fail(400, 'Invalid repository name');
  const dir = expand(baseDir || DEFAULT_DIR());
  const dest = path.join(dir, slug.split('/')[1]);
  if (fs.existsSync(path.join(dest, '.git'))) return { path: dest, existed: true };
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw fail(409, `${dest} already exists and is not empty`);
  fs.mkdirSync(dir, { recursive: true });
  const r = await run(GH(), ['repo', 'clone', slug, dest], { timeout: 300000 });
  if (!r.ok) throw fail(502, (r.stderr || 'Clone failed').trim());
  return { path: dest, existed: false };
}

async function createProject({ name, visibility, description, github, dir: baseDir }) {
  name = String(name || '').trim();
  if (!NAME_RE.test(name) || name === '.' || name === '..') throw fail(400, 'Use letters, numbers, dots, dashes and underscores for the name');
  const dir = expand(baseDir || DEFAULT_DIR());
  const dest = path.join(dir, name);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw fail(409, `${dest} already exists and is not empty`);
  fs.mkdirSync(dest, { recursive: true });
  let r = await git(dest, 'init', '-q', '-b', 'main');
  if (!r.ok) throw fail(500, r.stderr.trim());
  fs.writeFileSync(path.join(dest, 'README.md'), `# ${name}\n${description ? `\n${String(description).slice(0, 300)}\n` : ''}`);
  await git(dest, 'add', 'README.md');
  r = await git(dest, 'commit', '-q', '-m', 'Initial commit');
  if (!r.ok) r = await git(dest, '-c', 'user.name=Duo', '-c', 'user.email=duo@localhost', 'commit', '-q', '-m', 'Initial commit'); // no git identity configured yet
  if (!r.ok) throw fail(500, r.stderr.trim());
  if (!github) return { path: dest, github: false };

  const args = ['repo', 'create', name, visibility === 'public' ? '--public' : '--private', '--source=.', '--remote=origin', '--push'];
  if (description) args.push('--description', String(description).slice(0, 300));
  const g = await run(GH(), args, { cwd: dest, timeout: 120000 });
  forget();
  if (!g.ok) throw fail(502, `Created locally at ${dest}, but GitHub failed: ${(g.stderr || g.stdout).trim()}`);
  const url = (g.stdout.match(/https:\/\/github\.com\/\S+/) || [])[0];
  return { path: dest, github: true, url };
}

// Push a branch and open a pull request from it.
async function openPullRequest({ repoRoot, branch, base, title, body }) {
  const remote = await git(repoRoot, 'remote', 'get-url', 'origin');
  if (!remote.ok) throw fail(400, 'This project has no GitHub remote ("origin").');
  const hasBase = await git(repoRoot, 'ls-remote', '--exit-code', '--heads', 'origin', base);
  if (!hasBase.ok) throw fail(400, `The GitHub repo has no "${base}" branch yet, so there is nothing to open a pull request against. Click Apply, then Push to GitHub to publish "${base}" first.`);
  const push = await run('git', ['-C', repoRoot, 'push', '-u', 'origin', branch], { timeout: 120000 });
  if (!push.ok) throw fail(502, `Push failed: ${(push.stderr || push.stdout).trim()}`);
  const pr = await run(GH(), ['pr', 'create', '--head', branch, '--base', base, '--title', title.slice(0, 200), '--body', body], { cwd: repoRoot, timeout: 60000 });
  if (!pr.ok) throw fail(502, `Pushed ${branch}, but the pull request failed: ${(pr.stderr || pr.stdout).trim()}`);
  return { url: (pr.stdout.match(/https:\/\/\S+/) || [])[0] || null };
}

async function pushBranch(repoRoot, branch) {
  const r = await run('git', ['-C', repoRoot, 'push', '-u', 'origin', branch], { timeout: 120000 });
  if (!r.ok) throw fail(502, `Push failed: ${(r.stderr || r.stdout).trim()}`);
}

module.exports = { status, forget, startLogin, loginState, listRepos, cloneRepo, createProject, openPullRequest, pushBranch, DEFAULT_DIR };
