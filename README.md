# Status Line — Antigravity 2.0 Session Monitor

Monitors Antigravity 2.0 IDE session context window and step progression in real time. **No server, no browser, zero token consumption.** Pure Node.js.

Uses persistent JSON tracking to remember token counts across log compaction and restarts.

## 🚀 Installation & Setup (Quick Start)

Follow these simple steps to install and set up the status line monitor:

```bash
# 1. Clone the repository
git clone https://github.com/RaggioS/status-line-antigravity-2.0.git
cd status-line-antigravity-2.0

# 2. Register the tool globally (adds 'status-line-monitor' command system-wide)
npm link

# Note: on Windows PowerShell, if script execution is disabled, run:
# cmd /c npm link
```

### 💬 Install as a Slash Command (`/status-line`)

To make the `/status-line` command available inside your Antigravity 2.0 agent sessions:

1. Create a `.claude/commands/` folder at the root of your working projects if it doesn't exist.
2. Copy the command template from this repository into that folder:

```bash
# Linux/macOS
cp commands/status-line.md /path/to/your/project/.claude/commands/status-line.md

# Windows PowerShell (example)
copy commands\status-line.md C:\path\to\your\project\.claude\commands\status-line.md
```

Once copied, you can type or click `/status-line` inside your agent chat to see the updated context metrics!

---

## 🛠️ Usage

### 1. Live Interactive Dashboard
To monitor your active session in real-time inside a dedicated terminal window (refreshes every 1s, Ctrl+C to exit):
```bash
status-line-monitor
```

### 2. Print Dashboard Once
```bash
status-line-monitor --once
```

### 3. Print Single Status Line (Raw Output)
Used internally by the slash command and the agent to retrieve metrics without polluting the conversation:
```bash
status-line-monitor --status --conversationId <uuid>
```

---

## 🔍 Features

| Metric | Source | Real? |
|---|---|---|
| **Context window** | Transcript model selection (1M/2M limits) | ✅ Real |
| **Token estimate** | Dynamic characters-per-token ratio (3.14 for Gemini, 2.78 for Claude) | ✅ Real |
| **Token breakdown** | Classified user/model/tools character counts | ✅ Real |
| **Pipeline step** | Pattern-matched from `tool_calls` | ✅ Real |
| **Compaction proof** | Stores step-tokens in a persistent JSON database | ✅ Real |

---

## Requirements

- Node.js (any recent version)
- Antigravity 2.0 active session
