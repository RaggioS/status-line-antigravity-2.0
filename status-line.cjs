#!/usr/bin/env node
/**
 * status-line.cjs — Antigravity Session Monitor
 *
 * Usage:
 *   node status-line.cjs
 *   node status-line.cjs --conversationId <uuid>
 *   node status-line.cjs --appDataDir "C:\path\to\antigravity"
 *   node status-line.cjs --once          (print once and exit)
 *
 * No npm install needed. Pure Node.js built-ins only.
 * Press Ctrl+C to exit.
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

const APP_DATA = argv.appDataDir || 'C:\\Users\\raimo\\.gemini\\antigravity';
const ONCE     = argv.once === true;
const INTERVAL = 1000; // ms between refreshes
const FIVE_H   = 5 * 60 * 60 * 1000;
const SIX_H    = 6 * 60 * 60 * 1000;

// ─── ANSI helpers ───────────────────────────────────────────────────────────
const ESC = '\x1B';
const CLR = ESC + '[2J' + ESC + '[H';         // clear screen + home cursor
const HIDE_CURSOR = ESC + '[?25l';
const SHOW_CURSOR = ESC + '[?25h';

const c = {
  reset:   ESC + '[0m',
  bold:    ESC + '[1m',
  dim:     ESC + '[2m',
  // foreground
  white:   ESC + '[97m',
  gray:    ESC + '[90m',
  purple:  ESC + '[35m',
  cyan:    ESC + '[36m',
  green:   ESC + '[32m',
  yellow:  ESC + '[33m',
  red:     ESC + '[31m',
  blue:    ESC + '[34m',
  // bright
  bwhite:  ESC + '[1;97m',
  bpurple: ESC + '[1;35m',
  bcyan:   ESC + '[1;36m',
  bgreen:  ESC + '[1;32m',
  byellow: ESC + '[1;33m',
  bred:    ESC + '[1;31m',
};

function colored(color, text) { return color + text + c.reset; }

// ─── Auto-detect most recent conversation ───────────────────────────────────
function detectConversationId() {
  if (argv.conversationId) return argv.conversationId;
  const brainDir = path.join(APP_DATA, 'brain');
  if (!fs.existsSync(brainDir)) return null;
  try {
    return fs.readdirSync(brainDir)
      .filter(n => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n))
      .map(n => {
        try { return { n, mtime: fs.statSync(path.join(brainDir, n)).mtimeMs }; }
        catch { return { n, mtime: 0 }; }
      })
      .sort((a, b) => b.mtime - a.mtime)[0]?.n || null;
  } catch { return null; }
}

// ─── Session state ───────────────────────────────────────────────────────────
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

// ─── Log helpers ─────────────────────────────────────────────────────────────
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

// ─── Transcript line processor ───────────────────────────────────────────────
function processLine(line) {
  if (!line.trim()) return;
  let step;
  try { step = JSON.parse(line); }
  catch { return; }

  // Accumulate character counts in 5h window
  if (step.created_at) {
    const ts = new Date(step.created_at).getTime();
    if (ts > Date.now() - FIVE_H) {
      if (!state.firstStepTimestamp || ts < state.firstStepTimestamp)
        state.firstStepTimestamp = ts;

      if (step.source === 'USER_EXPLICIT') {
        if (step.content) state.userChars += step.content.length;
      } else if (step.source === 'MODEL') {
        if (step.thinking) state.modelChars += step.thinking.length;
        if (step.type === 'PLANNER_RESPONSE') {
          if (step.content) state.modelChars += step.content.length;
        } else {
          if (step.content) state.toolChars += step.content.length;
        }
        if (step.tool_calls)
          step.tool_calls.forEach(c => { state.toolChars += JSON.stringify(c).length; });
      } else if (step.source === 'SYSTEM') {
        if (step.content) state.toolChars += step.content.length;
      }
    }
  }

  // Tool calls → step detection
  if (step.source === 'MODEL' && step.tool_calls?.length) {
    step.tool_calls.forEach(call => {
      const t   = call.name;
      const a   = call.arguments || call.args || {};

      if (['view_file','list_dir','grep_search'].includes(t)) {
        const file = a.AbsolutePath || a.DirectoryPath || a.SearchPath || '';
        if (file.includes('implementation_plan.md')) {
          set(4,'planning','Reviewing implementation plan', 'Planning', 4);
          addLog('Reading implementation plan…');
        } else if (file.includes('task.md')) {
          set(6,'execution','Checking task list', 'Execution', 6);
          addLog('Checking task.md…');
        } else {
          set(3,'workspace','Scanning files', 'Workspace', 3);
          addLog('Reading: ' + path.basename(file || 'unknown'));
        }
      }
      else if (['write_to_file','replace_file_content','multi_replace_file_content'].includes(t)) {
        const file = a.TargetFile || '';
        set(6,'execution','Writing code', 'Execution', 6);
        addLog('Writing: ' + path.basename(file), 'SUCCESS');
      }
      else if (t === 'invoke_subagent') {
        set(6,'execution','Spawning subagent', 'Execution', 6);
        addLog('Spawning subagent…');
      }
      else if (t === 'run_command') {
        const cmd = (a.CommandLine || '').toLowerCase();
        if (/build|compile|test|pytest|vitest|jest/.test(cmd)) {
          set(8,'verification','Running build / tests', 'Verification', 8);
          addLog('Running verification…');
        } else if (/lint|eslint|flake8|black|mypy|pylint|check/.test(cmd)) {
          set(7,'gate-b','Quality checks', 'Gate B', 7);
          addLog('Running quality checks…');
        } else if (/commit|push|git add|checkout|branch/.test(cmd)) {
          set(9,'commit','Git sync', 'Commit', 9);
          addLog('Git: ' + (a.CommandLine || '').substring(0, 50));
        } else {
          set(6,'execution','Terminal command', 'Execution', 6);
          addLog('CMD: ' + (a.CommandLine || '').substring(0, 50));
        }
      }
      else if (t === 'search_web' || t === 'read_url_content') {
        set(3,'workspace','Web research', 'Workspace', 3);
        addLog('Searching/reading URL…');
      }
      else if (t === 'ask_question') {
        set(5,'gate-a','Awaiting user input', 'Gate A', 5);
        addLog('Waiting for user answer…');
      }
    });
  }
  else if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
    set(10,'recap-archive','Response delivered', 'Response', 10);
    addLog('Response sent to user.', 'SUCCESS');
    state.step10Timestamp = Date.now();
  }
  else if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT') {
    set(1,'orientation','New request received', 'Orientation', 1);
    state.consoleLogs = [];
    state.prompt = (step.content || '').slice(0, 120);
    addLog('New user message received.');
  }

  if (state.currentStep !== 10) state.step10Timestamp = null;
}

function set(step, phase, subTask, historyLabel, histNum) {
  state.currentStep = step;
  state.phase       = phase;
  state.subTask     = subTask;
  addHistory(historyLabel, histNum);
}

// ─── Incremental log reader ───────────────────────────────────────────────────
function readIncremental(logPath) {
  let stats;
  try { stats = fs.statSync(logPath); }
  catch { return; }

  const reg = state.fileRegistry;

  // Auto-transition step 10 → idle after 5s
  if (state.currentStep === 10 && state.step10Timestamp && Date.now() - state.step10Timestamp > 5000) {
    state.currentStep    = 0;
    state.phase          = 'idle';
    state.subTask        = 'Waiting…';
    state.step10Timestamp = null;
  }

  if (stats.mtimeMs <= reg.lastModifiedTime) return;
  reg.lastModifiedTime = stats.mtimeMs;

  if (stats.size < reg.lastSize) reg.lastSize = 0; // rotation
  const delta = stats.size - reg.lastSize;
  if (delta <= 0) return;

  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(delta);
    fs.readSync(fd, buf, 0, delta, reg.lastSize);
    fs.closeSync(fd);
    reg.lastSize = stats.size;
    buf.toString('utf8').split('\n').forEach(l => { if (l.trim()) processLine(l); });
  } catch (e) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtDuration(ms) {
  if (ms <= 0) return '0h 00m';
  const h = Math.floor(ms / (60 * 60 * 1000));
  const m = Math.floor((ms % (60 * 60 * 1000)) / 60_000);
  return h + 'h ' + String(m).padStart(2, '0') + 'm';
}

function asciiBar(pct, width, filledChar = '█', emptyChar = '░') {
  const filled = Math.round((pct / 100) * width);
  return filledChar.repeat(filled) + emptyChar.repeat(width - filled);
}

function pad(str, len) {
  const visible = str.replace(/\x1B\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - visible.length));
}

function box(width, ...lines) {
  const inner = width - 2;
  const top    = '┌' + '─'.repeat(inner) + '┐';
  const bottom = '└' + '─'.repeat(inner) + '┘';
  const divider = '├' + '─'.repeat(inner) + '┤';
  const row = (content) => {
    const visible = content.replace(/\x1B\[[0-9;]*m/g, '');
    const pad = Math.max(0, inner - 1 - visible.length);
    return '│ ' + content + ' '.repeat(pad) + '│';
  };
  return [top, ...lines.map(l => l === '---' ? divider : row(l)), bottom].join('\n');
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render(convId) {
  const now   = Date.now();
  const total = state.userChars + state.modelChars + state.toolChars;
  const tokens = Math.round(total / 3.8);

  // Context window
  const remaining = state.firstStepTimestamp
    ? Math.max(0, FIVE_H - (now - state.firstStepTimestamp))
    : FIVE_H;
  const ctxPct  = Math.min(100, ((FIVE_H - remaining) / FIVE_H) * 100);
  const ctxPctFmt = ctxPct.toFixed(1) + '%';

  let ctxBarColor;
  if (ctxPct > 80)      ctxBarColor = c.bred;
  else if (ctxPct > 50) ctxBarColor = c.byellow;
  else                  ctxBarColor = c.bpurple;

  // Step
  const step     = state.currentStep;
  const stepName = STEP_NAMES[step] || 'Idle';
  const stepBar  = Array.from({length: 10}, (_, i) => {
    const s = i + 1;
    if (s < step)  return colored(c.dim + c.green, '●');
    if (s === step) return colored(c.bgreen, '◉');
    return colored(c.gray, '○');
  }).join(' ');

  // Last log entry
  const lastLog = state.consoleLogs.length
    ? state.consoleLogs[state.consoleLogs.length - 1]
    : '—';
  const logColor = lastLog.includes('[SUCCESS]') ? c.bgreen
                 : lastLog.includes('[ERROR]')   ? c.bred
                 : c.gray;

  // Recent history (last 5)
  const recentHistory = state.history.slice(-5).reverse();

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

  const lines = [
    // ── Header ──────────────────────────────────────────────────────────
    colored(c.bpurple, '  ◈  STATUS LINE') +
      colored(c.gray, '  Antigravity Monitor') +
      colored(c.dim, '  ' + timeStr),

    '',

    // ── Session ──────────────────────────────────────────────────────────
    colored(c.gray, '  Session ') + colored(c.cyan, shortId) +
      colored(c.gray, '  ·  ') +
      (convId ? colored(c.bgreen, '● LIVE') : colored(c.bred, '● NO SESSION')),

    colored(c.gray, '  Last prompt: ') + colored(c.dim, promptExcerpt),

    '',

    // ── Context window ────────────────────────────────────────────────────
    colored(c.bwhite, '  Context Window  ') +
      ctxBarColor + asciiBar(ctxPct, BAR_W) + c.reset +
      colored(c.gray, '  ' + ctxPctFmt),

    colored(c.gray, '  ') +
      colored(c.cyan, fmtDuration(remaining) + ' remaining') +
      (state.firstStepTimestamp
        ? colored(c.dim, '  (started ' + new Date(state.firstStepTimestamp).toLocaleTimeString('en-US', { hour12: false }) + ')')
        : colored(c.dim, '  (no active session)')),

    '',

    // ── Tokens ────────────────────────────────────────────────────────────
    colored(c.bwhite, '  Tokens  ') +
      colored(c.bpurple, fmtTokens(tokens)) +
      colored(c.gray, ' estimated (÷3.8 from chars)'),

    colored(c.gray, '  User ') + colored(c.purple, fmtTokens(Math.round(state.userChars / 3.8))) +
      colored(c.gray, '  ·  Model ') + colored(c.cyan, fmtTokens(Math.round(state.modelChars / 3.8))) +
      colored(c.gray, '  ·  Tools ') + colored(c.green, fmtTokens(Math.round(state.toolChars / 3.8))),

    '',

    // ── Pipeline ──────────────────────────────────────────────────────────
    colored(c.bwhite, '  Pipeline  ') +
      (step > 0
        ? colored(c.bgreen, 'Step ' + step + '/10 — ' + stepName)
        : colored(c.gray, 'Idle')),

    '  ' + stepBar,

    colored(c.gray, '  ↳ ') + colored(c.white, state.subTask),

    '',

    // ── Last activity ─────────────────────────────────────────────────────
    colored(c.bwhite, '  Last activity'),
    colored(logColor, '  ' + lastLog.slice(0, W - 4)),
  ];

  // Recent history
  if (recentHistory.length > 0) {
    lines.push('');
    lines.push(colored(c.bwhite, '  Step history'));
    recentHistory.forEach(h => {
      lines.push(colored(c.dim, '  ' + h));
    });
  }

  lines.push('');
  lines.push(colored(c.gray, '  Press Ctrl+C to exit'));

  return lines.join('\n');
}

// ─── Main loop ────────────────────────────────────────────────────────────────
function main() {
  const convId = detectConversationId();
  if (!convId) {
    console.error('[status-line] ERROR: No Antigravity conversation found in', APP_DATA);
    console.error('  Pass --conversationId <uuid> or --appDataDir <path>');
    process.exit(1);
  }

  const logPath = path.join(APP_DATA, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');

  if (!fs.existsSync(logPath)) {
    console.error('[status-line] ERROR: Transcript not found:', logPath);
    console.error('  Is Antigravity IDE running? Is this the right appDataDir?');
    process.exit(1);
  }

  if (ONCE) {
    // Full scan, print once, exit
    readAllLines(logPath);
    process.stdout.write(render(convId) + '\n');
    process.exit(0);
  }

  // Live mode
  process.stdout.write(HIDE_CURSOR);
  process.on('exit', () => process.stdout.write(SHOW_CURSOR));
  process.on('SIGINT', () => {
    process.stdout.write(SHOW_CURSOR + '\n');
    process.exit(0);
  });

  // Initial full scan
  readAllLines(logPath);

  // First render
  process.stdout.write(CLR + render(convId));

  // Poll loop
  setInterval(() => {
    readIncremental(logPath);
    process.stdout.write(CLR + render(convId));
  }, INTERVAL);
}

function readAllLines(logPath) {
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    lines.forEach(l => { if (l.trim()) processLine(l); });
    state.fileRegistry.lastSize = Buffer.byteLength(content, 'utf8');
    state.fileRegistry.lastModifiedTime = fs.statSync(logPath).mtimeMs;
  } catch (e) {
    // file might not exist yet
  }
}

main();
