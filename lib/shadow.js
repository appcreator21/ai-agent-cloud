'use strict';
// "Work in place" tasks edit the user's real folder. To still show a diff and offer an undo, Duo
// keeps a private snapshot repo OUTSIDE the folder (git --git-dir=<shadow> --work-tree=<folder>).
// The user's folder gets no .git, and an existing repo's history, index and branches are untouched.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const EXCLUDES = ['node_modules/', '.DS_Store', '.duo/', '.venv/', 'venv/', '__pycache__/', '*.pyc', '.next/', '.cache/'];
const ID = ['-c', 'user.name=Duo', '-c', 'user.email=duo@localhost'];

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: 300000, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
const g = (shadow, folder, ...a) => run(['--git-dir', shadow, '--work-tree', folder, ...a], { cwd: folder });

async function snapshot(shadow, folder) {
  fs.mkdirSync(shadow, { recursive: true });
  const init = await run(['--git-dir', shadow, 'init', '-q']);
  if (!init.ok) return { ok: false, error: init.stderr.trim() };
  fs.mkdirSync(path.join(shadow, 'info'), { recursive: true });
  fs.writeFileSync(path.join(shadow, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
  await g(shadow, folder, 'add', '-A');
  const c = await g(shadow, folder, ...ID, 'commit', '-q', '--allow-empty', '-m', 'before');
  if (!c.ok) return { ok: false, error: c.stderr.trim() };
  await g(shadow, folder, 'tag', '-f', 'before');
  return { ok: true };
}

const exists = (shadow) => fs.existsSync(path.join(shadow, 'HEAD'));

async function changedFiles(shadow, folder) {
  if (!exists(shadow)) return [];
  await g(shadow, folder, 'add', '-A');
  const r = await g(shadow, folder, 'diff', '--cached', '--name-only', 'before');
  return r.stdout.split('\n').filter(Boolean);
}

async function diff(shadow, folder) {
  if (!exists(shadow)) return { diff: '', stat: '' };
  await g(shadow, folder, 'add', '-A');
  const [d, s] = await Promise.all([
    g(shadow, folder, 'diff', '--cached', '--no-color', 'before'),
    g(shadow, folder, 'diff', '--cached', '--stat', '--no-color', 'before'),
  ]);
  return { diff: d.stdout.slice(0, 2_000_000), stat: s.stdout };
}

// Puts the folder back the way it was at snapshot time: edits are reverted, files the agents
// created are deleted. Ignored folders such as node_modules are left alone.
async function undo(shadow, folder) {
  if (!exists(shadow)) throw new Error('No snapshot to restore from.');
  await g(shadow, folder, 'add', '-A');
  const r = await g(shadow, folder, 'reset', '-q', '--hard', 'before');
  if (!r.ok) throw new Error(r.stderr.trim() || 'Restore failed');
  await g(shadow, folder, 'clean', '-fdq');
}

const remove = (shadow) => fs.rmSync(shadow, { recursive: true, force: true });

module.exports = { snapshot, changedFiles, diff, undo, remove, exists };
