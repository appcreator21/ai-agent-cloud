'use strict';
// Reads the repo's GitHub Actions workflows and turns their `run:` steps into a short
// instruction for the agents, so what they hand back already passes the project's own CI.

const fs = require('node:fs');
const path = require('node:path');

// Steps that publish, deploy or touch cloud accounts are never something an agent should run.
const UNSAFE = /\b(publish|deploy|release|twine|docker\s+push|aws|gcloud|az\s|terraform|kubectl|helm|vercel|netlify|flyctl|heroku)\b|secrets\.|GITHUB_TOKEN|gh\s+release|git\s+push/i;
const MAX_COMMANDS = 25;

function stepsOf(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const val = m[2].trim();
    if (/^[|>][+-]?$/.test(val) || val === '') {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') continue;
        const ind = l.match(/^(\s*)/)[1].length;
        if (ind <= indent) break;
        out.push(l.trim());
        i = j;
      }
    } else out.push(val.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

function ciCommands(dir) {
  const wf = path.join(dir, '.github', 'workflows');
  let files = [];
  try { files = fs.readdirSync(wf).filter((f) => /\.ya?ml$/.test(f)).sort(); } catch { return { files: [], commands: [] }; }
  const commands = [];
  const used = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(wf, f), 'utf8'); } catch { continue; }
    const found = stepsOf(text)
      .map((c) => c.replace(/\s+\\$/, '').trim())
      .filter((c) => c && !c.startsWith('#') && !UNSAFE.test(c) && !/^(echo|set\s)/.test(c));
    if (found.length) used.push(f);
    for (const c of found) if (!commands.includes(c) && commands.length < MAX_COMMANDS) commands.push(c.slice(0, 200));
  }
  return { files: used, commands };
}

function ciSection(dir) {
  const { files, commands } = ciCommands(dir);
  if (!commands.length) return '';
  return `CI CHECKS
This repository's GitHub Actions (${files.map((f) => `.github/workflows/${f}`).join(', ')}) run these commands:
${commands.map((c) => `  $ ${c}`).join('\n')}
Before you finish, run the checks that apply to your changes (install dependencies only if they are missing; never run publish or deploy steps) and fix every failure you caused. If a check was already failing before your change, say so in your summary instead of hiding it. Do not weaken checks to get green: no deleting or skipping tests, no loosening lint or type rules.`;
}

module.exports = { ciCommands, ciSection, stepsOf };
