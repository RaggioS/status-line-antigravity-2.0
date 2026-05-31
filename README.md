# Status Line — Antigravity Session Monitor

Monitors Antigravity IDE sessions in real time. **No server, no browser, no npm install.** Pure Node.js.

## Usage

```bash
# Live dashboard (updates every 1s, Ctrl+C to exit)
node status-line.cjs

# Print once and exit (for scripts / shell prompts)
node status-line.cjs --once

# Specific conversation
node status-line.cjs --conversationId <uuid>

# Custom appData path
node status-line.cjs --appDataDir "C:\path\to\antigravity"
```

## What it shows

| Metric | Source | Real? |
|---|---|---|
| Context window | Transcript model selection (1M/2M limits) | ✅ Real |
| Token estimate | `chars / 3.8` from log content + CLAUDE.md | ✅ Real |
| Token breakdown (user/model/tools) | Classified by `source` field | ✅ Real |
| Pipeline step | Pattern-matched from `tool_calls` | ✅ Real |
| Rate limit reset | 60s rolling requests tracker | ✅ Real |

## Requirements

- Node.js (any recent version)
- Antigravity IDE running with default appData path, or pass `--appDataDir`
