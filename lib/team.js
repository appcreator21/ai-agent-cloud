'use strict';
// Team mode: two agents share one git worktree and talk through a file-based
// mailbox in <worktree>/.duo/. Files (not HTTP) because Codex's sandbox has no
// network, while both agents can always run a local node script.

const fs = require('node:fs');
const path = require('node:path');

const EXCLUDE = ':(exclude).duo'; // keep the mailbox out of every diff and commit
// Unlimited by default. Set DUO_MAX_TURNS=<n> to cap how many turns each agent may take.
const MAX_TURNS = Number(process.env.DUO_MAX_TURNS) > 0 ? Number(process.env.DUO_MAX_TURNS) : Infinity;
const LABEL = { claude: 'Claude Code', codex: 'Codex' };
const other = (a) => (a === 'claude' ? 'codex' : 'claude');

const SENDER = (from, to) => `#!/usr/bin/env node
// Sends a message from ${from} to ${to}. Usage: node .duo/${from}/to-${to}.js "message"
const fs = require('fs'), path = require('path');
const text = process.argv.slice(2).join(' ').trim();
if (!text) { console.error('usage: node .duo/${from}/to-${to}.js "message"'); process.exit(1); }
const root = path.join(__dirname, '..');
fs.appendFileSync(path.join(root, 'messages.jsonl'), JSON.stringify({ from: '${from}', to: '${to}', text, ts: Date.now() }) + '\\n');
${to === 'you' ? '' : `fs.appendFileSync(path.join(root, '${to}', 'inbox.md'), '\\n### From ${LABEL[from]} (' + new Date().toLocaleTimeString() + ')\\n' + text + '\\n');`}
console.log('Message sent to ${to === 'you' ? 'the human' : LABEL[to]}.');
`;

function setupTeamDir(dir) {
  const root = path.join(dir, '.duo');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'messages.jsonl'), '');
  fs.writeFileSync(path.join(root, 'CONTRACT.md'),
    '# Contract\n\nShared interface agreed by both agents: API routes and payloads, shared types, env vars, ports.\nKeep it short and current. Update it whenever an interface changes.\n');
  for (const a of ['claude', 'codex']) {
    fs.mkdirSync(path.join(root, a), { recursive: true });
    fs.writeFileSync(path.join(root, a, 'inbox.md'), `# Inbox for ${LABEL[a]}\n\n(no messages yet)\n`);
    fs.writeFileSync(path.join(root, a, `to-${other(a)}.js`), SENDER(a, other(a)));
    fs.writeFileSync(path.join(root, a, 'to-you.js'), SENDER(a, 'you'));
  }
}

function appendMessage(dir, msg) {
  const root = path.join(dir, '.duo');
  fs.appendFileSync(path.join(root, 'messages.jsonl'), JSON.stringify(msg) + '\n');
  if (msg.to === 'claude' || msg.to === 'codex') {
    fs.appendFileSync(path.join(root, msg.to, 'inbox.md'), `\n### From ${msg.from === 'you' ? 'the human' : LABEL[msg.from]}\n${msg.text}\n`);
  }
}

function fmtMsg(m) {
  return `- ${m.from === 'you' ? 'The human' : LABEL[m.from]}: ${m.text}`;
}

function buildPrompt({ agent, goal, roles, turn, pending = [], changedFiles = [], ci = '' }) {
  const mate = other(agent);
  const head = `You are ${LABEL[agent]}, one of two AI engineers working TOGETHER in the same git working tree (your current directory) on one project.

SHARED GOAL
${goal}

YOUR ASSIGNMENT: ${roles[agent]}
YOUR TEAMMATE (${LABEL[mate]}) IS HANDLING: ${roles[mate]}

HOW YOU WORK TOGETHER
- Only create or edit files that belong to your assignment. If you need something changed in your teammate's area, ask them instead of editing it.
- Agree on interfaces early. Shared contract (API routes, request/response shapes, shared types, env vars, ports) lives in .duo/CONTRACT.md. Read it before you start. If it is still empty, write your side of it first, then message your teammate. Update it whenever an interface changes.
- Talk to your teammate with: node .duo/${agent}/to-${mate}.js "your message"
  Keep messages short and concrete: a decision, a question, or "ready: <what>". Only message when it needs action or an answer from them. Never send thanks or acknowledgements: replying to one would restart their turn for nothing.
- Your inbox is .duo/${agent}/inbox.md. Read it (cat) before you start, after each major piece of work, and before you finish.
- To ask the human something, or to flag a blocker: node .duo/${agent}/to-you.js "message". Do not wait for an answer; continue with what you can do.
- Do not wait or poll for your teammate. Do everything you can now, send them what they need, then finish.
- Do not run git commit, checkout, switch, stash, reset or rebase. Duo handles version control. Do not edit anything in .duo/ except CONTRACT.md.
- When you finish, reply with a short summary: what you built, what you need from your teammate (if anything).${ci ? `\n\n${ci}\nIn a team, run the checks on the whole tree once your teammate's side has landed; if a failure is in their area, message them instead of editing it.` : ''}`;

  if (turn <= 1 && !pending.length) return head;

  const msgs = pending.length ? `NEW MESSAGES FOR YOU (you may already have read some in your inbox)\n${pending.map(fmtMsg).join('\n')}\n` : '';
  const files = changedFiles.length ? `FILES CHANGED SO FAR BY THE TEAM\n${changedFiles.slice(0, 40).map((f) => `- ${f}`).join('\n')}\n` : '';
  return `${head}

THIS IS FOLLOW-UP TURN ${turn}. Your previous turn ended; the work so far is already in the working tree.
${msgs}
${files}
Act on the new messages within your assignment, reply to your teammate if needed, update .duo/CONTRACT.md if an interface changed, and finish with a short summary. If nothing needs doing, say so briefly.`;
}

module.exports = { EXCLUDE, MAX_TURNS, LABEL, other, setupTeamDir, appendMessage, buildPrompt };
