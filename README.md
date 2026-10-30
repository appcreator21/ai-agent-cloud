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
- An idle agent is woken automatically when it gets a message (no turn limit by default; the **Stop all** button halts everything, and `DUO_MAX_TURNS=<n>` sets an optional cap).
- A team is never closed for good: after **Apply**, send a message in the channel and both agents wake up in the same thread (the team reopens, and Apply merges whatever they add). Only **Discard** or deleting the task removes the workspace.
- You can message either agent or both at any time; agents can ask you with `to-you.js`, which highlights in amber.
- One shared diff and one Apply/Discard for the whole team. The `.duo/` folder is never committed.

Modes (Compete): **Build** (agents may edit and run commands in their worktree) and **Plan** (read-only).

## CI-aware agents

If the project has GitHub Actions workflows, Duo reads their `run:` steps (dropping publish/deploy/cloud steps) and tells the agents
to run the relevant checks (lint, types, tests) and fix what they broke before finishing, in Compete, Team and Build mode.
The task header shows a "runs CI checks" tag. Plan mode (read-only) skips this. It is a strong nudge, not a guarantee:
agents can still miss something, so keep CI on pull requests as the safety net.

## Choosing models

The **Models** button in the composer sets the model for each agent (Claude Code: Default, Opus, Sonnet, Haiku, or any model id; Codex: Default or any model id).
Default means "whatever the CLI is already set to". The choice is remembered, passed to the CLI as `--model` / `-m`, and shown on each lane.

## Branch or Folder

The **Branch / Folder** switch next to the project field decides where the agents work.

- **Branch** (default for git projects): each agent works on its own git branch in a hidden copy. You review, then Apply or open a PR.
- **Folder**: the agents edit the chosen folder directly. It works with any folder, git or not, and you can point it at a brand new one (it is created). On a Mac, the folder icon opens a native folder picker.

Folder mode has no Apply step because the changes are already there. Instead Duo takes a private snapshot first (kept outside your folder; it never adds a `.git` to a plain folder
and never touches an existing repo's history, index or branches). **View changes** shows a diff against that snapshot and **Undo changes** puts the folder back, deleting files the agents created.
`node_modules`, `.venv`, `.DS_Store` and similar are left out of the snapshot. Compete mode in a folder runs one agent (two would collide); Team mode lets both share the folder.
Duo refuses folders that are too broad, such as your home folder, Desktop, Documents or Downloads themselves.

## Focus and full screen

Every pane (each agent and the channel) has an expand button. Click it and that pane fills the screen as a comfortable reading column,
while the others fold into slim rails showing their status (the channel rail shows unread messages). Click a rail to switch focus.
The full screen button then hides the sidebar, header and composer, and uses the browser's full screen too (Ctrl/Cmd+Shift+F).
Esc steps back one level: full screen first, then focus. All of it is also in the command palette.

## Starting from scratch

Point the repo field at anything and Duo makes it workable: a brand-new empty GitHub clone, a `git init` with no commits,
an empty folder, or a folder that does not exist yet (it is created). Duo adds a first commit so the agents have a base to
branch from. A non-empty folder that is not a git repo asks before git is set up. With an empty GitHub repo, use **Apply**
then **Push to GitHub** to publish `main`; after that **Open PR** works for later changes.

## Signing in to Claude Code and Codex

The Sign in buttons open a small box with the exact command (`claude` then `/login`, or `codex login`), a Copy button, an
"Open Terminal for me" button on a Mac, and a check that notices the login on its own. Duo cannot drive those interactive logins itself.

## Make it a Mac app

```bash
cd ~/duo && npm run mac-app
```

This builds `~/Applications/Duo.app` with its own icon. Open it from Spotlight (Cmd+Space, "Duo") or drag it into the Dock.
It starts the server if needed and opens Duo in its own chromeless window (Chrome, Brave, Edge, Chromium or Vivaldi; otherwise your
default browser). Closing the window or pressing Cmd+Q stops the server. Logs go to `~/Library/Logs/Duo.log`.
If the icon still looks generic after building, run `killall Dock Finder` once.

The app runs from a copy in `~/Library/Application Support/Duo/runtime`, so run `npm run mac-app` again after every `git pull` to update it.

macOS blocks apps from reading Documents, Desktop and Downloads until you allow them. If your projects live there, give the app access once:
System Settings > Privacy & Security > Full Disk Access > `+` > choose `Duo.app`, then quit and reopen it. Without that, Duo shows "blocked by macOS" next to the project.

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
