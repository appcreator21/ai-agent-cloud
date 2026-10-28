# Duo

Run **Claude Code** and **Codex** side by side on the same task. Each agent works in its own
git worktree and branch, you watch both live, compare the diffs, then merge the one you like.

Duo drives the official CLIs, so billing stays on your subscriptions
(Claude Pro/Max and ChatGPT), not on API keys.

## Use

```bash
npm i -g @anthropic-ai/claude-code @openai/codex   # if not installed
npm start                                          # http://localhost:4317
```

1. Click **Sign in** next to each agent (runs `claude auth login` / `codex login`; the browser opens).
2. Pick a git repository, type a task, press Ctrl/Cmd + Enter.
3. Review each lane's activity and **Changes**, then **Apply** (merges the branch) or **Discard**.

### Team mode

Switch **Compete** to **Team**, give each agent its part (for example Claude Code = backend, Codex = frontend)
and a shared goal. Both work in **one shared worktree** and talk through a channel:

- Agents message each other with a tiny script in `.duo/` (a file mailbox: Codex's sandbox has no network, so files are the reliable transport).
- They agree on interfaces in `.duo/CONTRACT.md`. Messages show up live in the middle column, with a glowing packet flying between the two lanes.
- An idle agent is woken automatically when it gets a message (max 4 turns each, to stop ping-pong loops).
- You can message either agent or both at any time; agents can ask you with `to-you.js`, which highlights in amber.
- One shared diff and one Apply/Discard for the whole team. The `.duo/` folder is never committed.

Modes (Compete): **Build** (agents may edit and run commands in their worktree) and **Plan** (read-only).

## Starting from scratch

Point the repo field at anything and Duo makes it workable: a brand-new empty GitHub clone, a `git init` with no commits,
an empty folder, or a folder that does not exist yet (it is created). Duo adds a first commit so the agents have a base to
branch from. A non-empty folder that is not a git repo asks before git is set up. With an empty GitHub repo, use **Apply**
then **Push to GitHub** to publish `main`; after that **Open PR** works for later changes.

## GitHub

Duo uses the GitHub CLI (`gh`) so it never handles a token. Install it once (`brew install gh`), then:

- **Connect:** click Connect in the sidebar. A browser tab opens and Duo shows a one-time code to enter there.
- **Projects** (button next to the repo field): reopen a recent project, **clone any of your GitHub repos** and use it, or **create a new project** (locally, or on GitHub as private/public, with a first commit so agents can branch from it).
- **Open PR:** pushes an agent's (or the team's) branch and opens a pull request, without touching your local main.
- **Push to GitHub:** after **Apply**, pushes the merged branch.

## Also

- **Command palette** (Ctrl/Cmd+K): new task, switch mode, sign in/out, jump to any task. Up/Down in an empty prompt recalls earlier prompts.
- **Live "now" line** per agent, touched-file chips, a compare strip (time, files, tokens, fastest) when both finish, and per-file attribution in the team diff.
- **Run again** reloads a task into the composer. Finished runs update the tab title and (if allowed) send a desktop notification when the tab is hidden.
- **Robustness:** Stop kills the whole process group, turns time out after 45 min (`DUO_TURN_TIMEOUT_MIN`), worktree/merge operations are serialized, runs are refused with a clear message if a CLI is missing or signed out, usage-limit and auth errors get a plain-language hint, and the UI resyncs after a dropped connection.
- **Tests:** `npm test` boots the real server against fake CLIs and covers compete, team messaging and wake-ups, apply/conflict/discard, cancel, delete and the Host/Origin guard.

## Notes

- API-key variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) are removed from the agent processes so
  the CLIs cannot silently fall back to pay-per-token billing. The sidebar warns if a CLI is signed in with a key.
- Agents branch from the last commit; uncommitted changes in your repo are not visible to them.
- The server listens on 127.0.0.1 only and rejects foreign Host/Origin headers.
- Subscription limits are shared across parallel runs; heavy parallel use on Claude Pro will hit them quickly.
- Check each provider's terms: this tool only launches their official CLIs and never touches their tokens.
- `npm run dev` uses fake CLIs in `test/fake` so you can try the UI without logging in.
