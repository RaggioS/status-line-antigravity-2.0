/**
 * monitor.cjs — Status Line Backend Daemon
 *
 * Reads Antigravity IDE transcript logs in real time and writes
 * a session_state.json file consumed by the frontend.
 *
 * What this measures (honestly):
 *   - tokenUsage:         estimated from raw character count / 3.8 (approximation)
 *   - firstStepTimestamp: real timestamp of the first log entry within the 5h window
 *   - pipeline step:      inferred from tool_calls patterns in the transcript
 *   - token breakdown:    classified by source (USER_EXPLICIT / MODEL / SYSTEM)
 *
 * What this does NOT claim to know:
 *   - Rate limit reset time (Antigravity does not expose this)
 *   - Exact token count (character-based estimation only)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── CLI arguments ───────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i].startsWith('--')) {
    args[process.argv[i].replace('--', '')] = process.argv[i + 1];
  }
}

const appDataDir = args.appDataDir || 'C:\\Users\\raimo\\.gemini\\antigravity';
const workspaceDir = args.workspaceDir
  || 'C:\\Users\\raimo\\Documents\\AI Projects\\status-line-new-antigravity';

// Auto-detect the most recently modified conversation in brain/
let conversationId = args.conversationId;
if (!conversationId) {
  const brainDir = path.join(appDataDir, 'brain');
  if (fs.existsSync(brainDir)) {
    try {
      const folders = fs.readdirSync(brainDir)
        .filter(name => /^[0-9a-f-]{36}$/i.test(name))
        .map(name => {
          const p = path.join(brainDir, name);
          try { return { name, mtime: fs.statSync(p).mtimeMs }; }
          catch { return { name, mtime: 0 }; }
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (folders.length > 0) conversationId = folders[0].name;
    } catch { /* ignore */ }
  }
}
if (!conversationId) {
  console.error('[Monitor] ERROR: Could not detect conversationId. Pass --conversationId <uuid>');
  process.exit(1);
}

const sessionStatePath = path.join(workspaceDir, 'public', 'session_state.json');

// Ensure public/ directory exists
const publicDir = path.dirname(sessionStatePath);
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

console.log('[Monitor] Status Line Monitor starting...');
console.log(`[Monitor] AppData:        ${appDataDir}`);
console.log(`[Monitor] ConversationID: ${conversationId}`);
console.log(`[Monitor] Output:         ${sessionStatePath}`);

// ── Session state ────────────────────────────────────────────────────────────
const state = {
  id: conversationId,
  currentStep: 0,
  phase: 'idle',
  subTask: 'Waiting for instructions',
  explanation: 'The monitor is starting up.',
  consoleLogs: [],
  history: [],
  // Token tracking (character-based estimation)
  userChars: 0,
  modelChars: 0,
  toolChars: 0,
  firstStepTimestamp: null,
  // Subagent tracking
  subagentsRegistry: {},
  subagentIds: [],
  step10Timestamp: null,
};

// Registry of subagent transcripts to also monitor
const filesRegistry = {}; // { convId: { lastSize, lastModifiedTime } }
const sessionsStates = {}; // { convId: state }
const lastInvokeArgs = {}; // { convId: [...] }

// ── Step detection helpers ──────────────────────────────────────────────────
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SIX_HOURS_MS  = 6 * 60 * 60 * 1000;

function addLog(session, message, type = 'INFO') {
  const entry = `[${type}] ${message}`;
  if (!session.consoleLogs.includes(entry)) {
    session.consoleLogs.push(entry);
    if (session.consoleLogs.length > 25) session.consoleLogs.shift();
  }
}

function addHistory(session, stepName, stepNum) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = `[${time}] ${stepName} (Step ${stepNum})`;
  const alreadyExists = session.history.some(h =>
    h.includes(`(Step ${stepNum})`) && h.slice(10) === entry.slice(10)
  );
  if (!alreadyExists) {
    session.history.push(entry);
    if (session.history.length > 20) session.history.shift();
  }
}

// ── Process a single transcript line ─────────────────────────────────────────
function processLine(line, convId, mainConvId) {
  if (!line.trim()) return;
  let step;
  try { step = JSON.parse(line); }
  catch { return; }

  // Initialise session bucket if new
  if (!sessionsStates[convId]) {
    const isMain = convId === mainConvId;
    const subData = state.subagentsRegistry[convId];
    sessionsStates[convId] = {
      id: convId,
      isMain,
      name: isMain ? 'Orchestrator' : (subData?.name || `Session-${convId.slice(0, 8)}`),
      role: isMain ? 'Orchestrator' : (subData?.role || 'Subagent'),
      parentId: subData?.parentId || null,
      currentStep: 0,
      phase: 'idle',
      subTask: 'Waiting',
      explanation: '',
      consoleLogs: [],
      history: [],
      userChars: 0,
      modelChars: 0,
      toolChars: 0,
      firstStepTimestamp: null,
      subagentIds: [],
      step10Timestamp: null,
      prompt: '',
    };
  }

  const session = sessionsStates[convId];

  // ── Accumulate character counts within 5h window ─────────────────────────
  if (step.created_at) {
    const ts = new Date(step.created_at).getTime();
    if (ts > Date.now() - FIVE_HOURS_MS) {
      if (!session.firstStepTimestamp || ts < session.firstStepTimestamp) {
        session.firstStepTimestamp = ts;
      }
      if (step.source === 'USER_EXPLICIT') {
        if (step.content) session.userChars += step.content.length;
      } else if (step.source === 'MODEL') {
        if (step.thinking) session.modelChars += step.thinking.length;
        if (step.type === 'PLANNER_RESPONSE') {
          if (step.content) session.modelChars += step.content.length;
        } else {
          if (step.content) session.toolChars += step.content.length;
        }
        if (step.tool_calls) {
          step.tool_calls.forEach(c => {
            session.toolChars += JSON.stringify(c).length;
          });
        }
      } else if (step.source === 'SYSTEM') {
        if (step.content) session.toolChars += step.content.length;
      }
    }
  }

  // ── Tool call → pipeline step mapping ────────────────────────────────────
  if (step.source === 'MODEL' && step.tool_calls?.length > 0) {
    step.tool_calls.forEach(call => {
      const tool = call.name;
      const a = call.arguments || call.args || {};

      if (['view_file', 'list_dir', 'grep_search'].includes(tool)) {
        const file = a.AbsolutePath || a.DirectoryPath || a.SearchPath || '';
        if (file.includes('implementation_plan.md')) {
          session.currentStep = 4; session.phase = 'planning';
          session.subTask = 'Reviewing implementation plan';
          session.explanation = 'Reading implementation_plan.md.';
          addHistory(session, 'Planning', 4);
          addLog(session, 'Reading implementation plan...');
        } else if (file.includes('task.md')) {
          session.currentStep = 6; session.phase = 'execution';
          session.subTask = 'Checking task.md';
          session.explanation = 'Reviewing task progress list.';
          addHistory(session, 'Execution', 6);
          addLog(session, 'Checking task list...');
        } else {
          session.currentStep = 3; session.phase = 'workspace';
          session.subTask = 'Scanning files';
          session.explanation = 'Exploring repository files.';
          addHistory(session, 'Workspace Check', 3);
          addLog(session, `Reading: ${path.basename(file || 'unknown')}`);
        }
      }

      else if (['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(tool)) {
        const file = a.TargetFile || '';
        if (!file.includes('session_state.json')) {
          session.currentStep = 6; session.phase = 'execution';
          session.subTask = 'Writing code';
          session.explanation = `Editing: ${path.basename(file)}`;
          addHistory(session, 'Execution', 6);
          addLog(session, `Writing: ${path.basename(file)}`, 'SUCCESS');
        }
      }

      else if (tool === 'invoke_subagent') {
        let list = [];
        try { list = typeof a.Subagents === 'string' ? JSON.parse(a.Subagents) : a.Subagents; }
        catch { /* ignore */ }
        if (Array.isArray(list)) {
          lastInvokeArgs[convId] = list.map(sa => ({
            name: sa.TypeName, role: sa.Role, prompt: sa.Prompt
          }));
        }
        session.currentStep = 6; session.phase = 'execution';
        session.subTask = 'Spawning subagent';
        session.explanation = 'Delegating task to subagent.';
        addHistory(session, 'Execution', 6);
        addLog(session, 'Spawning subagent...');
      }

      else if (tool === 'run_command') {
        const cmd = (a.CommandLine || '').toLowerCase();
        if (/build|compile|test|pytest|vitest|jest|cargo/.test(cmd)) {
          session.currentStep = 8; session.phase = 'verification';
          session.subTask = 'Build / Tests';
          session.explanation = 'Running build or test suite.';
          addHistory(session, 'Verification', 8);
          addLog(session, 'Running verification...');
        } else if (/lint|eslint|flake8|black|mypy|pylint|check|fmt|format/.test(cmd)) {
          session.currentStep = 7; session.phase = 'gate-b';
          session.subTask = 'Quality checks';
          session.explanation = 'Running linting / formatting.';
          addHistory(session, 'Gate B', 7);
          addLog(session, 'Running quality checks...');
        } else if (/commit|push|git add|checkout|branch/.test(cmd)) {
          session.currentStep = 9; session.phase = 'commit';
          session.subTask = 'Git sync';
          session.explanation = 'Committing or pushing changes.';
          addHistory(session, 'Commit & PR', 9);
          addLog(session, `Git: ${(a.CommandLine || '').substring(0, 40)}`);
        } else {
          session.currentStep = 6; session.phase = 'execution';
          session.subTask = 'Terminal command';
          session.explanation = `Running: ${(a.CommandLine || '').substring(0, 60)}`;
          addHistory(session, 'Execution', 6);
          addLog(session, `CMD: ${(a.CommandLine || '').substring(0, 40)}...`);
        }
      }
    });
  }

  // ── PLANNER_RESPONSE = step 10, response delivered ───────────────────────
  else if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
    session.currentStep = 10; session.phase = 'recap-archive';
    session.subTask = 'Response delivered';
    session.explanation = 'Agent sent final response to user.';
    addHistory(session, 'Response', 10);
    addLog(session, 'Response sent.', 'SUCCESS');
    session.step10Timestamp = Date.now();

    // Propagate recap to parent if subagent
    if (session.parentId && sessionsStates[session.parentId]) {
      const parent = sessionsStates[session.parentId];
      const msg = `Subagent ${session.name} done.`;
      if (!parent.consoleLogs.some(l => l.includes(msg))) {
        addLog(parent, msg, 'SUCCESS');
      }
    }
  }

  // ── INVOKE_SUBAGENT result → link subagent ID ─────────────────────────────
  else if (step.source === 'MODEL' && step.type === 'INVOKE_SUBAGENT' && step.status === 'DONE') {
    const jsonMatch = (step.content || '').match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const details = JSON.parse(jsonMatch[0]);
        const subId = details.conversationId;
        const pending = lastInvokeArgs[convId];
        if (subId && pending?.length > 0) {
          const subData = pending.shift();
          state.subagentsRegistry[subId] = {
            id: subId, name: subData.name, role: subData.role,
            prompt: subData.prompt, parentId: convId
          };
          if (!session.subagentIds.includes(subId)) session.subagentIds.push(subId);
          addLog(session, `Linked subagent: ${subData.name}`);
        }
      } catch { /* ignore */ }
    }
  }

  // ── USER_INPUT → reset to step 1 ─────────────────────────────────────────
  else if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT') {
    session.currentStep = 1; session.phase = 'orientation';
    session.subTask = 'Receiving new request';
    session.explanation = 'User sent a new message.';
    session.consoleLogs = [];
    session.prompt = step.content || '';
    addHistory(session, 'Orientation', 1);
    addLog(session, 'New user request received.');
  }

  // Reset step10 timer if no longer on step 10
  if (session.currentStep !== 10) session.step10Timestamp = null;
}

// ── Scan brain/ for active conversation folders ───────────────────────────
function scanActiveSessions(mainConvId) {
  const brainDir = path.join(appDataDir, 'brain');
  if (!fs.existsSync(brainDir)) return [];
  const cutoff = Date.now() - SIX_HOURS_MS;
  try {
    return fs.readdirSync(brainDir)
      .filter(name => /^[0-9a-f-]{36}$/i.test(name))
      .map(name => {
        const tp = path.join(brainDir, name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(tp)) return null;
        try {
          const mtime = fs.statSync(tp).mtimeMs;
          return (mtime > cutoff || name === mainConvId) ? { id: name, transcriptPath: tp, mtime } : null;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

// ── Write session_state.json ──────────────────────────────────────────────
function writeState(mainConvId) {
  const sessionsObj = {};
  Object.keys(sessionsStates).forEach(cid => {
    const s = sessionsStates[cid];
    const totalChars = s.userChars + s.modelChars + s.toolChars;
    sessionsObj[cid] = {
      id: s.id,
      name: s.name,
      role: s.role,
      isMain: s.isMain,
      parentId: s.parentId,
      subagentIds: s.subagentIds,
      prompt: s.prompt,
      activeStep: s.currentStep,
      phase: s.phase,
      subTask: s.subTask,
      explanation: s.explanation,
      consoleLogs: s.consoleLogs,
      history: s.history,
      firstStepTimestamp: s.firstStepTimestamp,
      // Token estimates (char / 3.8 ≈ tokens, rough but real)
      tokenUsage: Math.round(totalChars / 3.8),
      tokenUsageDetails: {
        user:  Math.round(s.userChars  / 3.8),
        model: Math.round(s.modelChars / 3.8),
        tool:  Math.round(s.toolChars  / 3.8),
        total: Math.round(totalChars   / 3.8),
      },
    };
  });

  const output = {
    mainConversationId: mainConvId,
    lastUpdated: Date.now(),
    sessions: sessionsObj,
  };

  try {
    fs.writeFileSync(sessionStatePath, JSON.stringify(output, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Monitor] Write error: ${err.message}`);
  }
}

// ── Main polling loop ─────────────────────────────────────────────────────
function poll(mainConvId) {
  const active = scanActiveSessions(mainConvId);
  let changed = false;

  active.forEach(({ id: cid, transcriptPath }) => {
    if (!filesRegistry[cid]) filesRegistry[cid] = { lastSize: 0, lastModifiedTime: 0 };
    const reg = filesRegistry[cid];

    let stats;
    try { stats = fs.statSync(transcriptPath); }
    catch { return; }

    // Auto-transition step 10 → idle after 5s
    const s = sessionsStates[cid];
    if (s?.currentStep === 10 && s.step10Timestamp && Date.now() - s.step10Timestamp > 5000) {
      s.currentStep = 0; s.phase = 'idle';
      s.subTask = 'Waiting for instructions';
      s.explanation = 'Agent is idle.';
      s.step10Timestamp = null;
      changed = true;
    }

    if (stats.mtimeMs <= reg.lastModifiedTime) return;
    reg.lastModifiedTime = stats.mtimeMs;

    // Handle log rotation / truncation
    if (stats.size < reg.lastSize) reg.lastSize = 0;

    const delta = stats.size - reg.lastSize;
    if (delta <= 0) return;

    let fd;
    try {
      fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(delta);
      fs.readSync(fd, buf, 0, delta, reg.lastSize);
      fs.closeSync(fd);
      reg.lastSize = stats.size;

      buf.toString('utf8').split('\n').forEach(line => {
        if (line.trim()) { processLine(line, cid, mainConvId); changed = true; }
      });
    } catch (e) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
      console.error(`[Monitor] Read error for ${cid}: ${e.message}`);
    }
  });

  if (changed) writeState(mainConvId);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
poll(conversationId);
console.log('[Monitor] Active. Polling every 1s...\n');
setInterval(() => poll(conversationId), 1000);
