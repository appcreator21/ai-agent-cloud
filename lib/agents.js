'use strict';
// Adapters for the official Claude Code and Codex CLIs. Each one knows how to
// launch the CLI headless, check its login, and turn its JSONL stream into a
// small set of UI items: meta, text, tool, tool_result, final, error, usage.

function hintFor(text) {
  const t = String(text || '');
  if (/usage limit|rate.?limit|quota|limit reached|too many requests|\b429\b|credit/i.test(t)) return 'limit';
  if (/not (logged|signed) in|please (log|sign) in|unauthori[sz]ed|\b401\b|invalid api key|authentication/i.test(t)) return 'auth';
  return undefined;
}

const clip = (s, n = 1200) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n... (${s.length - n} more chars)` : s;
};

function toolSummary(name, input = {}) {
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description;
  return v ? clip(v, 300) : clip(JSON.stringify(input), 300);
}

function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
  return '';
}

const claude = {
  label: 'Claude Code',
  bin: () => process.env.DUO_CLAUDE_BIN || 'claude',
  apiKeyVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  statusArgs: ['auth', 'status'],
  loginArgs: ['auth', 'login'],
  logoutArgs: ['auth', 'logout'],
  parseStatus({ ok, stdout, stderr }) {
    const text = `${stdout}\n${stderr}`;
    try {
      const j = JSON.parse(stdout);
      const method = String(j.authMethod || j.method || '');
      const loggedIn = j.loggedIn !== false && ok;
      return {
        loggedIn,
        detail: loggedIn ? [j.email, j.subscriptionType && `${j.subscriptionType} plan`].filter(Boolean).join(' - ') || 'Signed in' : 'Not signed in',
        warning: /api/i.test(method) ? 'Authenticated with an API key (pay per token). Sign in with your Claude account to use your plan.' : undefined,
      };
    } catch { /* plain text */ }
    const loggedIn = ok && !/not (logged|signed)|no auth|log in to/i.test(text);
    return { loggedIn, detail: loggedIn ? (text.trim().split('\n')[0] || 'Signed in') : 'Not signed in' };
  },
  build({ prompt, mode, model }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    args.push('--permission-mode', mode === 'review' ? 'plan' : 'acceptEdits');
    if (mode !== 'review') args.push('--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep');
    if (model) args.push('--model', model);
    return { args, input: prompt }; // prompt goes via stdin: no arg injection
  },
};

const codex = {
  label: 'Codex',
  bin: () => process.env.DUO_CODEX_BIN || 'codex',
  apiKeyVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  statusArgs: ['login', 'status'],
  loginArgs: ['login'],
  logoutArgs: ['logout'],
  parseStatus({ ok, stdout, stderr }) {
    const text = `${stdout}\n${stderr}`.trim();
    if (!ok || /not logged in/i.test(text)) return { loggedIn: false, detail: 'Not signed in' };
    if (/api key/i.test(text)) {
      return { loggedIn: true, detail: 'API key', warning: 'Authenticated with an API key (pay per token). Run "codex login" to sign in with ChatGPT instead.' };
    }
    return { loggedIn: true, detail: /chatgpt/i.test(text) ? 'ChatGPT account' : text.split('\n')[0] || 'Signed in' };
  },
  build({ prompt, mode, dir, model }) {
    const args = ['exec', '--json', '--sandbox', mode === 'review' ? 'read-only' : 'workspace-write', '-C', dir];
    if (model) args.push('-m', model);
    args.push('-');
    return { args, input: prompt };
  },
};

const adapters = { claude, codex };

// ---------- stream parsing ----------
function parseClaude(ev, state) {
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') {
    out.push({ kind: 'meta', text: `Model ${ev.model || 'default'}` });
  } else if (ev.type === 'assistant') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) out.push({ kind: 'text', text: c.text });
      else if (c.type === 'tool_use') {
        const f = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name) && (c.input?.file_path || c.input?.notebook_path);
        out.push({ kind: 'tool', id: c.id, name: c.name, summary: toolSummary(c.name, c.input), ...(f ? { files: [f] } : {}) });
      }
    }
  } else if (ev.type === 'user') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'tool_result') out.push({ kind: 'tool_result', id: c.tool_use_id, text: clip(flatten(c.content)), error: !!c.is_error });
    }
  } else if (ev.type === 'result') {
    const u = ev.usage || {};
    out.push({
      kind: 'usage',
      usage: {
        durationMs: ev.duration_ms, turns: ev.num_turns,
        inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        outputTokens: u.output_tokens,
      },
    });
    if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
      state.failed = true;
      out.push({ kind: 'error', text: ev.result || ev.subtype || 'Run failed' });
    } else if (ev.result) out.push({ kind: 'final', text: ev.result });
  }
  return out;
}

function parseCodex(ev, state) {
  const out = [];
  const item = ev.item || {};
  if (ev.type === 'thread.started') {
    out.push({ kind: 'meta', text: 'Session started' });
  } else if (ev.type === 'item.started' || ev.type === 'item.completed') {
    const done = ev.type === 'item.completed';
    switch (item.type) {
      case 'agent_message':
        if (done && item.text) out.push({ kind: 'text', text: item.text });
        break;
      case 'command_execution':
        if (!done) { state[item.id] = true; out.push({ kind: 'tool', id: item.id, name: 'Shell', summary: clip(item.command, 300) }); }
        else {
          if (!state[item.id]) out.push({ kind: 'tool', id: item.id, name: 'Shell', summary: clip(item.command, 300) });
          out.push({ kind: 'tool_result', id: item.id, text: clip(item.aggregated_output), error: item.exit_code != null && item.exit_code !== 0 });
        }
        break;
      case 'file_change':
        if (done) out.push({ kind: 'tool', id: item.id, name: 'Edit', summary: (item.changes || []).map((c) => `${c.kind} ${c.path}`).join(', ') || 'file change', files: (item.changes || []).map((c) => c.path) }, { kind: 'tool_result', id: item.id, text: '' });
        break;
      case 'mcp_tool_call':
        if (!done) out.push({ kind: 'tool', id: item.id, name: `${item.server || 'mcp'}.${item.tool || ''}`, summary: clip(JSON.stringify(item.arguments || {}), 300) });
        break;
      case 'web_search':
        if (!done) out.push({ kind: 'tool', id: item.id, name: 'WebSearch', summary: clip(item.query, 300) });
        break;
      case 'error':
        if (done) out.push({ kind: 'error', text: item.message });
        break;
      default: break; // reasoning, todo_list: skipped to keep the feed readable
    }
  } else if (ev.type === 'turn.completed') {
    const u = ev.usage || {};
    out.push({ kind: 'usage', usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens } });
  } else if (ev.type === 'turn.failed' || ev.type === 'error') {
    state.failed = true;
    out.push({ kind: 'error', text: ev.error?.message || ev.message || 'Run failed' });
  }
  return out;
}

function parseLine(agent, line, state) {
  let ev;
  try { ev = JSON.parse(line); } catch { return [{ kind: 'raw', text: clip(line, 500) }]; }
  try { return agent === 'claude' ? parseClaude(ev, state) : parseCodex(ev, state); } catch { return []; }
}

module.exports = { adapters, parseLine, hintFor };
