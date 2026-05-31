#!/usr/bin/env node
/**
 * status-line.cjs — Antigravity 2.0 Session Monitor
 *
 * Usage:
 *   node status-line.cjs
 *   node status-line.cjs --status        (prints single status line and exits)
 *   node status-line.cjs --once          (prints dashboard once and exits)
 *   node status-line.cjs --conversationId <uuid>
 *   node status-line.cjs --appDataDir "C:\path\to\antigravity"
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI args ───────────────────────────────────────────────────────────────
const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const key = process.argv[i].slice(2);
    const val = process.argv[i + 1];
    argv[key] = (val && !val.startsWith('--')) ? (i++, val) : true;
  }
}

const APP_DATA_DIRS = [
  'C:\\Users\\raimo\\.gemini\\antigravity',
  'C:\\Users\\raimo\\.gemini\\antigravity-cli',
  'C:\\Users\\raimo\\.gemini\\antigravity-ide'
];

const ONCE     = argv.once === true;
const STATUS   = argv.status === true;
const INTERVAL = 1000; // ms between refreshes

const BASE_SYSTEM_PROMPT_TOKENS = 5000;

// ─── ANSI helpers ───────────────────────────────────────────────────────────
const ESC = '\x1B';
const CLR = ESC + '[2J' + ESC + '[H';         // clear screen + home cursor
const HIDE_CURSOR = ESC + '[?25l';
const SHOW_CURSOR = ESC + '[?25h';

const c = {
  reset:   ESC + '[0m',
  bold:    ESC + '[1m',
  dim:     ESC + '[2m',
  white:   ESC + '[97m',
  gray:    ESC + '[90m',
  purple:  ESC + '[35m',
  cyan:    ESC + '[36m',
  green:   ESC + '[32m',
  yellow:  ESC + '[33m',
  red:     ESC + '[31m',
  blue:    ESC + '[34m',
  bwhite:  ESC + '[1;97m',
  bpurple: ESC + '[1;35m',
  bcyan:   ESC + '[1;36m',
  bgreen:  ESC + '[1;32m',
  byellow: ESC + '[1;33m',
  bred:    ESC + '[1;31m',
};

function colored(color, text) { return color + text + c.reset; }

// ─── Auto-detect most recent conversation ───────────────────────────────────
function getLatestConversation() {
  if (argv.conversationId) {
    const appData = argv.appDataDir || APP_DATA_DIRS[0];
    const logPath = path.join(appData, 'brain', argv.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    return { convId: argv.conversationId, logPath, appData };
  }

  const allConversations = [];
  for (const appDir of APP_DATA_DIRS) {
    const brainDir = path.join(appDir, 'brain');
    if (!fs.existsSync(brainDir)) continue;
    try {
      const dirs = fs.readdirSync(brainDir);
      for (const d of dirs) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d)) continue;
        const logPath = path.join(brainDir, d, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(logPath)) continue;
        try {
          const mtime = fs.statSync(logPath).mtimeMs;
          allConversations.push({ convId: d, logPath, appData: appDir, mtime });
        } catch {}
      }
    } catch {}
  }

  if (allConversations.length === 0) return null;
  allConversations.sort((a, b) => b.mtime - a.mtime);
  return allConversations[0];
}

// Global parsing variables & limits
let transcriptTokens = 0;
let claudeMdTokens = 0;
let currentPromptTokens = 0;
let modelName = 'Gemini 3.5 Flash';
let contextLimit = 1000000;

// ─── Token Model Ratios ──────────────────────────────────────────────────────
function getRatioForModel(name) {
  const n = name.toLowerCase();
  if (n.includes('gemini')) return 3.14; // Weighted average for coding sessions (code/JSON/IT/EN)
  if (n.includes('claude') || n.includes('sonnet')) return 2.78; // Claude BPE tokenizer
  return 3.0; // General safe fallback
}

// ─── Token and file helpers ──────────────────────────────────────────────────
function calculateFileTokens(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return Math.floor(content.length / getRatioForModel(modelName));
  } catch {
    return 0;
  }
}

// ─── Persistent storage helpers ──────────────────────────────────────────────
function loadPersistedSteps(appData, convId) {
  const tokenFile = path.join(appData, 'brain', convId, 'session_tokens.json');
  if (fs.existsSync(tokenFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      return data.steps || {};
    } catch {
      return {};
    }
  }
  return {};
}

function savePersistedSteps(appData, convId, steps) {
  const brainDir = path.join(appData, 'brain', convId);
  if (!fs.existsSync(brainDir)) return;
  const tokenFile = path.join(brainDir, 'session_tokens.json');
  try {
    fs.writeFileSync(tokenFile, JSON.stringify({ steps }, null, 2), 'utf8');
  } catch {}
}

// ─── Transcript parsing and stats ───────────────────────────────────────────
const STEP_NAMES = [
  '', 'Orientation', 'Sizing', 'Workspace', 'Planning',
  'Gate A', 'Execution', 'Gate B', 'Verification', 'Commit', 'Response'
];

const state = {
  currentStep: 0,
  phase: 'idle',
  subTask: 'Waiting…',
  explanation: '',
  userChars: 0,
  modelChars: 0,
  toolChars: 0,
  firstStepTimestamp: null,
  consoleLogs: [],
  history: [],
  step10Timestamp: null,
  prompt: '',
  lastLogLine: null,
  fileRegistry: { lastSize: 0, lastModifiedTime: 0 },
  initialized: false,
};

function addLog(msg, type = 'INFO') {
  const entry = `[${type}] ${msg}`;
  state.consoleLogs.push(entry);
  if (state.consoleLogs.length > 30) state.consoleLogs.shift();
  state.lastLogLine = entry;
}

function addHistory(stepName, stepNum) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = `${time}  ${stepName} (Step ${stepNum})`;
  if (!state.history.some(h => h.endsWith(`(Step ${stepNum})`))) {
    state.history.push(entry);
    if (state.history.length > 15) state.history.shift();
  }
}

function set(step, phase, subTask, historyLabel, histNum) {
  state.currentStep = step;
  state.phase       = phase;
  state.subTask     = subTask;
  addHistory(historyLabel, histNum);
}

function parseTranscriptFile(logPath, appData, convId) {
  if (!fs.existsSync(logPath)) return;
  
  let content;
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch {
    return;
  }

  const lines = content.split('\n');
  let currentModelName = 'Gemini 3.5 Flash';
  let currentContextLimit = 1000000;

  // Load previously persisted step counts
  const steps = loadPersistedSteps(appData, convId);
  let lastUserInputIndex = 0;

  // Reset character counts for interactive UI view
  state.userChars = 0;
  state.modelChars = 0;
  state.toolChars = 0;

  lines.forEach(line => {
    if (!line.trim()) return;
    let step;
    try { step = JSON.parse(line); } catch { return; }

    const stepType = step.type || '';
    const source = step.source || '';
    let stepChars = 0;

    if (stepType === 'USER_INPUT') {
      lastUserInputIndex = step.step_index;
    }

    // Character metrics
    if (stepType === 'USER_INPUT' && step.content) {
      stepChars = step.content.length;
      state.userChars += stepChars;
    } else if (stepType === 'PLANNER_RESPONSE') {
      stepChars = (step.thinking || '').length + (step.content || '').length + (step.tool_calls ? JSON.stringify(step.tool_calls).length : 0);
      state.modelChars += stepChars;
    } else if (step.content) {
      stepChars = step.content.length;
      state.toolChars += stepChars;
    }

    // Model selection parsing with strict regex boundary checks
    if (step.content && step.content.includes('Model Selection')) {
      const match = step.content.match(/Model Selection.*?(?:from\s+[a-zA-Z0-9.\s()]+)?\s+to\s+([a-zA-Z0-9.\s()]+)/i);
      if (match) {
        const destModel = match[1].toLowerCase();
        if (destModel.includes('pro')) {
          currentModelName = 'Gemini 3.5 Pro';
          currentContextLimit = 2000000;
        } else if (destModel.includes('flash')) {
          currentModelName = 'Gemini 3.5 Flash';
          currentContextLimit = 1000000;
        } else if (destModel.includes('sonnet')) {
          currentModelName = 'Claude Sonnet 4.6';
          currentContextLimit = 200000;
        }
      }
    }

    // Save tokens using current model specific characters-per-token ratio
    if (step.step_index !== undefined) {
      const ratio = getRatioForModel(currentModelName);
      steps[step.step_index] = Math.floor(stepChars / ratio);
    }

    // Step detection for terminal activity view
    if (source === 'MODEL' && step.tool_calls?.length) {
      step.tool_calls.forEach(call => {
        const t = call.name;
        const a = call.arguments || call.args || {};

        if (['view_file','list_dir','grep_search'].includes(t)) {
          const file = a.AbsolutePath || a.DirectoryPath || a.SearchPath || '';
          if (file.includes('implementation_plan.md')) {
            set(4,'planning','Reviewing implementation plan', 'Planning', 4);
          } else if (file.includes('task.md')) {
            set(6,'execution','Checking task list', 'Execution', 6);
          } else {
            set(3,'workspace','Scanning files', 'Workspace', 3);
          }
        } else if (['write_to_file','replace_file_content','multi_replace_file_content'].includes(t)) {
          set(6,'execution','Writing code', 'Execution', 6);
        } else if (t === 'invoke_subagent') {
          set(6,'execution','Spawning subagent', 'Execution', 6);
        } else if (t === 'run_command') {
          const cmd = (a.CommandLine || '').toLowerCase();
          if (/build|compile|test|pytest|vitest|jest/.test(cmd)) {
            set(8,'verification','Running build / tests', 'Verification', 8);
          } else if (/lint|eslint|flake8|black|mypy|pylint|check/.test(cmd)) {
            set(7,'gate-b','Quality checks', 'Gate B', 7);
          } else if (/commit|push|git add|checkout|branch/.test(cmd)) {
            set(9,'commit','Git sync', 'Commit', 9);
          } else {
            set(6,'execution','Terminal command', 'Execution', 6);
          }
        } else if (t === 'search_web' || t === 'read_url_content') {
          set(3,'workspace','Web research', 'Workspace', 3);
        } else if (t === 'ask_question') {
          set(5,'gate-a','Awaiting user input', 'Gate A', 5);
        }
      });
    } else if (source === 'MODEL' && stepType === 'PLANNER_RESPONSE') {
      set(10,'recap-archive','Response delivered', 'Response', 10);
      state.step10Timestamp = Date.now();
    } else if (source === 'USER_EXPLICIT' && stepType === 'USER_INPUT') {
      set(1,'orientation','New request received', 'Orientation', 1);
      state.prompt = (step.content || '').slice(0, 120);
    }
  });

  // Save the updated steps back to the persistent file
  savePersistedSteps(appData, convId, steps);

  // Sum all steps to get active context window tokens
  transcriptTokens = Object.values(steps).reduce((sum, val) => sum + val, 0);

  // Calculate current prompt/turn tokens (sum of step-tokens in the current prompt/response turn)
  currentPromptTokens = 0;
  Object.keys(steps).forEach(stepIdx => {
    const idx = parseInt(stepIdx, 10);
    if (idx >= lastUserInputIndex) {
      currentPromptTokens += steps[stepIdx];
    }
  });

  modelName = currentModelName;
  contextLimit = currentContextLimit;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000)     return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render(convId) {
  const total = BASE_SYSTEM_PROMPT_TOKENS + claudeMdTokens + transcriptTokens;
  const percentContext = (total / contextLimit) * 100;
  const ctxPctFmt = percentContext.toFixed(1) + '%';

  let ctxBarColor = c.bpurple;
  if (percentContext > 80)      ctxBarColor = c.bred;
  else if (percentContext > 50) ctxBarColor = c.byellow;

  // Step
  const step     = state.currentStep;
  const stepName = STEP_NAMES[step] || 'Idle';
  const stepBar  = Array.from({length: 10}, (_, i) => {
    const s = i + 1;
    if (s < step)  return colored(c.dim + c.green, '●');
    if (s === step) return colored(c.bgreen, '◉');
    return colored(c.gray, '○');
  }).join(' ');

  // Prompt excerpt
  const promptExcerpt = state.prompt
    ? '"' + state.prompt.slice(0, 60) + (state.prompt.length > 60 ? '…' : '') + '"'
    : '—';

  // Time
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
  const shortId = convId ? convId.slice(0, 8) : '????????';

  // Width
  const W = Math.min(process.stdout.columns || 80, 80);
  const BAR_W = W - 22;

  // Render ASCII progress bar
  const filled = Math.round((percentContext / 100) * BAR_W);
  const bar = ctxBarColor + '█'.repeat(filled) + c.dim + '░'.repeat(BAR_W - filled) + c.reset;

  const lines = [
    colored(c.bpurple, '  ◈  STATUS LINE') +
      colored(c.gray, '  Antigravity Monitor') +
      colored(c.dim, '  ' + timeStr),
    '',
    colored(c.gray, '  Session ') + colored(c.cyan, shortId) +
      colored(c.gray, '  ·  ') +
      (convId ? colored(c.bgreen, '● LIVE') : colored(c.bred, '● NO SESSION')),
    colored(c.gray, '  Last prompt: ') + colored(c.dim, promptExcerpt),
    '',
    colored(c.bwhite, '  Context Window  ') +
      bar +
      colored(c.gray, '  ' + ctxPctFmt),
    colored(c.gray, '  ') +
      colored(c.cyan, `${fmtTokens(contextLimit - total)} remaining`) +
      colored(c.dim, `  (model: ${modelName})`),
    '',
    colored(c.bwhite, '  Context Tokens  ') +
      colored(c.bpurple, fmtTokens(total)) +
      colored(c.gray, ` total active context tokens (max: ${fmtTokens(contextLimit)})`),
    colored(c.gray, '  Base System ') + colored(c.purple, fmtTokens(BASE_SYSTEM_PROMPT_TOKENS)) +
      colored(c.gray, '  ·  CLAUDE.md ') + colored(c.cyan, fmtTokens(claudeMdTokens)) +
      colored(c.gray, '  ·  Active Transcript ') + colored(c.green, fmtTokens(transcriptTokens)),
    '',
    colored(c.bwhite, '  Last Turn Increment  ') +
      colored(c.byellow, `+${fmtTokens(currentPromptTokens)}`) +
      colored(c.gray, ` net new tokens added using 1 token ≈ ${getRatioForModel(modelName)} chars ratio`),
    '',
    colored(c.bwhite, '  Pipeline  ') +
      (step > 0
        ? colored(c.bgreen, 'Step ' + step + '/10 — ' + stepName)
        : colored(c.gray, 'Idle')),
    '  ' + stepBar,
    colored(c.gray, '  ↳ ') + colored(c.white, state.subTask),
    '',
    colored(c.gray, '  Press Ctrl+C to exit')
  ];

  return lines.join('\n');
}

function getStatusLineString() {
  const total = BASE_SYSTEM_PROMPT_TOKENS + claudeMdTokens + transcriptTokens;
  const percentContext = (total / contextLimit) * 100;

  const bar_length = 10;
  const filled_length = Math.min(bar_length, Math.round((percentContext / 100) * bar_length));
  const bar = '■'.repeat(filled_length) + '□'.repeat(bar_length - filled_length);

  const ctx_str = (total / 1000).toFixed(1) + 'k';
  const ctx_lim_str = contextLimit >= 1000000 ? (contextLimit / 1000000).toFixed(1) + 'M' : (contextLimit / 1000).toFixed(0) + 'k';

  const prompt_str = fmtTokens(currentPromptTokens);

  return `📊 Status: Context ~${ctx_str} / ${ctx_lim_str} (${percentContext.toFixed(1)}%) [${bar}] | Prompt: +${prompt_str}`;
}

// ─── Main loop ────────────────────────────────────────────────────────────────
function main() {
  const conv = getLatestConversation();
  if (!conv) {
    console.error('[status-line] ERROR: No active conversation found.');
    process.exit(1);
  }

  const claudeMdPath = path.resolve(__dirname, '..', 'CLAUDE.md');
  claudeMdTokens = calculateFileTokens(claudeMdPath);

  if (STATUS) {
    parseTranscriptFile(conv.logPath, conv.appData, conv.convId);
    process.stdout.write(getStatusLineString() + '\n');
    process.exit(0);
  }

  if (ONCE) {
    parseTranscriptFile(conv.logPath, conv.appData, conv.convId);
    process.stdout.write(render(conv.convId) + '\n');
    process.exit(0);
  }

  // Live monitor CLI dashboard mode
  process.stdout.write(HIDE_CURSOR);
  process.on('exit', () => process.stdout.write(SHOW_CURSOR));
  process.on('SIGINT', () => {
    process.stdout.write(SHOW_CURSOR + '\n');
    process.exit(0);
  });

  // Init scan
  parseTranscriptFile(conv.logPath, conv.appData, conv.convId);
  process.stdout.write(CLR + render(conv.convId));

  // Loop poll
  setInterval(() => {
    parseTranscriptFile(conv.logPath, conv.appData, conv.convId);
    process.stdout.write(CLR + render(conv.convId));
  }, INTERVAL);
}

main();
