import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  BrainCircuit,
  Clock,
  Terminal,
  Layers,
  ChevronDown,
  ChevronUp,
  Activity,
  Cpu,
  GitBranch,
  User,
  Bot,
  Wrench,
} from 'lucide-react';

// ── Constants ──────────────────────────────────────────────────────────────
const STEP_NAMES = [
  '', 'Orientation', 'Sizing', 'Workspace', 'Planning',
  'Gate A', 'Execution', 'Gate B', 'Verification', 'Commit', 'Response'
];

const STEP_COLORS = [
  '', '#38bdf8', '#a78bfa', '#818cf8', '#fbbf24',
  '#f97316', '#a855f7', '#ec4899', '#34d399', '#06b6d4', '#10b981'
];

const PHASE_LABELS = {
  idle: 'Idle',
  orientation: 'Orientation',
  sizing: 'Sizing',
  workspace: 'Workspace scan',
  planning: 'Planning',
  'gate-a': 'Gate A',
  execution: 'Execution',
  'gate-b': 'Gate B',
  verification: 'Verification',
  commit: 'Commit & PR',
  'recap-archive': 'Response',
};

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms) {
  if (ms <= 0) return '0h 00m';
  const h = Math.floor(ms / (60 * 60 * 1000));
  const m = Math.floor((ms % (60 * 60 * 1000)) / 60_000);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// ── Dot indicator ──────────────────────────────────────────────────────────
function LiveDot({ color = '#34d399' }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8, flexShrink: 0 }}>
      <span
        className="animate-ping"
        style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          backgroundColor: color, opacity: 0.6,
        }}
      />
      <span style={{ position: 'relative', borderRadius: '50%', width: 8, height: 8, backgroundColor: color }} />
    </span>
  );
}

// ── Section heading ────────────────────────────────────────────────────────
function SectionTitle({ children, icon: Icon }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      {Icon && <Icon size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
      <span style={{
        fontSize: 10, fontWeight: 800, textTransform: 'uppercase',
        letterSpacing: '0.7px', color: 'var(--text-muted)',
      }}>
        {children}
      </span>
    </div>
  );
}

// ── Context window bar ─────────────────────────────────────────────────────
function ContextWindowBar({ firstStepTimestamp, now }) {
  const remaining = firstStepTimestamp
    ? Math.max(0, FIVE_HOURS_MS - (now - firstStepTimestamp))
    : FIVE_HOURS_MS;
  const pct = 100 - (remaining / FIVE_HOURS_MS) * 100;

  let barColor;
  if (pct > 80) barColor = 'linear-gradient(90deg, #f97316, #ef4444)';
  else if (pct > 50) barColor = 'linear-gradient(90deg, #fbbf24, #f97316)';
  else barColor = 'linear-gradient(90deg, #818cf8, #a855f7)';

  return (
    <div className="metric-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <SectionTitle icon={Clock}>Context Window</SectionTitle>
        <span className="badge" style={{
          background: 'var(--cyan-dim)', border: '1px solid var(--cyan-border)', color: 'var(--cyan)',
        }}>
          {formatDuration(remaining)} left
        </span>
      </div>

      <div className="progress-track">
        <div
          className="progress-bar"
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
        <span>{pct.toFixed(1)}% used</span>
        {firstStepTimestamp
          ? <span>Started {new Date(firstStepTimestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
          : <span>No session detected</span>
        }
      </div>
    </div>
  );
}

// ── Token usage card ───────────────────────────────────────────────────────
function TokenCard({ tokenUsage, tokenUsageDetails, isOpen, onToggle }) {
  const total = tokenUsage || 0;
  const details = tokenUsageDetails || { user: 0, model: 0, tool: 0, total: 0 };

  const categories = [
    { key: 'user',  label: 'User',  icon: User,  color: '#a855f7' },
    { key: 'model', label: 'Model', icon: Bot,   color: '#38bdf8' },
    { key: 'tool',  label: 'Tools', icon: Wrench, color: '#34d399' },
  ];

  return (
    <div className="metric-card" style={{ cursor: 'pointer' }} onClick={onToggle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <SectionTitle icon={BrainCircuit}>Token Usage</SectionTitle>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            estimated
          </span>
          {isOpen ? <ChevronUp size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} />}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span className="metric-value" style={{ color: 'var(--purple)', fontSize: 28 }}>
          {formatTokens(total)}
        </span>
        <span className="metric-sub">tokens</span>
      </div>

      {isOpen && (
        <div
          className="fade-in"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 6 }}
          onClick={e => e.stopPropagation()}
        >
          {categories.map(({ key, label, icon: Icon, color }) => {
            const val = details[key] || 0;
            const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
            return (
              <div
                key={key}
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-xs)',
                  padding: '8px 10px',
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Icon size={10} style={{ color }} />
                  <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.5px' }}>
                    {label}
                  </span>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'white' }}>
                  {formatTokens(val)}
                </span>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {pct}%
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Disclaimer */}
      <p style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
        Estimated from character count (÷ 3.8). Not exact — no API token endpoint available.
      </p>
    </div>
  );
}

// ── Pipeline step bar ──────────────────────────────────────────────────────
function PipelineBar({ activeStep, phase, subTask, explanation }) {
  const step = activeStep || 0;
  const color = STEP_COLORS[step] || '#4b5563';
  const stepName = STEP_NAMES[step] || 'Idle';
  const phaseLabel = PHASE_LABELS[phase] || phase || 'Idle';

  return (
    <div className="metric-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <SectionTitle icon={Layers}>Pipeline</SectionTitle>
        <span className="badge" style={{
          background: `${color}18`, border: `1px solid ${color}40`, color,
        }}>
          {step > 0 ? `Step ${step}/10` : 'Idle'}
        </span>
      </div>

      {/* Step indicators */}
      <div style={{ display: 'flex', gap: 3, alignItems: 'center', margin: '4px 0' }}>
        {Array.from({ length: 10 }, (_, i) => {
          const s = i + 1;
          const isActive = s === step;
          const isDone = s < step;
          return (
            <div
              key={s}
              title={STEP_NAMES[s]}
              style={{
                flex: 1, height: 4, borderRadius: 2,
                background: isActive ? color : isDone ? `${color}60` : 'rgba(255,255,255,0.06)',
                transition: 'background 0.3s',
                boxShadow: isActive ? `0 0 6px ${color}80` : 'none',
              }}
            />
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {step > 0 && <LiveDot color={color} />}
          <span style={{ fontSize: 13, fontWeight: 700, color: step > 0 ? color : 'var(--text-muted)' }}>
            {stepName}
          </span>
        </div>
        {subTask && (
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            {subTask}
          </span>
        )}
        {explanation && (
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            {explanation}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Console logs ───────────────────────────────────────────────────────────
function ConsoleLogs({ logs = [], isOpen, onToggle }) {
  const ref = useRef(null);
  useEffect(() => {
    if (isOpen && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [logs, isOpen]);

  return (
    <div className="metric-card">
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
        onClick={onToggle}
      >
        <SectionTitle icon={Terminal}>Activity Log</SectionTitle>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            background: 'rgba(255,255,255,0.06)', borderRadius: 4,
            padding: '1px 6px', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)',
          }}>
            {logs.length}
          </span>
          {isOpen ? <ChevronUp size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} />}
        </div>
      </div>

      {isOpen && (
        <div
          ref={ref}
          className="fade-in"
          style={{
            maxHeight: 200, overflowY: 'auto',
            background: '#05060a', borderRadius: 6,
            border: '1px solid var(--border-subtle)',
            padding: '8px 10px',
            marginTop: 4,
          }}
        >
          {logs.length === 0
            ? <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No activity yet.</span>
            : logs.map((log, i) => {
              const isSuccess = log.includes('[SUCCESS]');
              const isError = log.includes('[ERROR]');
              const isWarn = log.includes('[WARN]');
              return (
                <div
                  key={i}
                  className={`log-entry${isSuccess ? ' success' : isError ? ' error' : isWarn ? ' warn' : ''}`}
                >
                  {log}
                </div>
              );
            })
          }
        </div>
      )}
    </div>
  );
}

// ── Session history ────────────────────────────────────────────────────────
function SessionHistory({ history = [], isOpen, onToggle }) {
  return (
    <div className="metric-card">
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
        onClick={onToggle}
      >
        <SectionTitle icon={GitBranch}>Step History</SectionTitle>
        {isOpen ? <ChevronUp size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} />}
      </div>

      {isOpen && (
        <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          {history.length === 0
            ? <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>No history yet.</span>
            : [...history].reverse().map((entry, i) => (
              <div key={i} style={{
                fontSize: 11, color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)', lineHeight: 1.4,
                borderLeft: '2px solid var(--border)', paddingLeft: 8,
              }}>
                {entry}
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

// ── Main StatusMonitor ────────────────────────────────────────────────────
export default function StatusMonitor() {
  const [data, setData] = useState(null);
  const [now, setNow] = useState(0);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  // Clock tick — updates every 30s (only needed for context window display)
  useEffect(() => {
    const id = setTimeout(() => setNow(Date.now()), 0);
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearTimeout(id); clearInterval(interval); };
  }, []);

  // Poll session_state.json every 1s
  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/session_state.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) { setError('session_state.json not found — is monitor.cjs running?'); return; }
      const json = await res.json();
      setData(json);
      setError(null);
    } catch {
      setError('Cannot reach session_state.json — is monitor.cjs running?');
    }
  }, []);

  useEffect(() => {
    fetchState();
    pollRef.current = setInterval(fetchState, 1000);
    return () => clearInterval(pollRef.current);
  }, [fetchState]);

  // Pick the main session to display
  const session = useMemo(() => {
    if (!data) return null;
    const mainId = data.mainConversationId;
    return data.sessions?.[mainId] || Object.values(data.sessions || {})[0] || null;
  }, [data]);

  return (
    <div style={{
      minHeight: '100vh',
      background: 'radial-gradient(ellipse 80% 60% at 50% 0%, rgba(88, 28, 220, 0.12) 0%, transparent 60%), var(--bg-base)',
      padding: '32px 0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ width: '100%', maxWidth: 540, padding: '0 20px', marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 10,
              background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 20px rgba(168, 85, 247, 0.35)',
            }}>
              <Activity size={17} color="white" />
            </div>
            <div>
              <h1 style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.2px' }}>
                Status Line
              </h1>
              <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                Antigravity Session Monitor
              </p>
            </div>
          </div>

          {/* Live / error badge */}
          {error ? (
            <span className="badge" style={{ background: 'var(--red-dim)', border: '1px solid var(--red-border)', color: 'var(--red)' }}>
              Offline
            </span>
          ) : data ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <LiveDot />
              <span className="badge" style={{ background: 'var(--emerald-dim)', border: '1px solid var(--emerald-border)', color: 'var(--emerald)' }}>
                Live
              </span>
            </div>
          ) : (
            <span className="badge" style={{ background: 'var(--amber-dim)', border: '1px solid var(--amber-border)', color: 'var(--amber)' }}>
              Connecting…
            </span>
          )}
        </div>
      </div>

      {/* ── Error state ─────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          width: '100%', maxWidth: 540, padding: '0 20px', marginBottom: 20,
        }}>
          <div style={{
            background: 'var(--red-dim)', border: '1px solid var(--red-border)',
            borderRadius: 'var(--radius)', padding: '16px 20px',
          }}>
            <p style={{ fontSize: 12, color: 'var(--red)', fontFamily: 'var(--font-mono)', lineHeight: 1.6 }}>
              {error}
            </p>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Run: <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--amber)' }}>node monitor.cjs</code> in the project directory.
            </p>
          </div>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      {session && (
        <div style={{
          width: '100%', maxWidth: 540, padding: '0 20px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          {/* Session name pill */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Cpu size={12} style={{ color: 'var(--text-muted)' }} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {session.name} · {session.id?.slice(0, 8)}
            </span>
          </div>

          <ContextWindowBar firstStepTimestamp={session.firstStepTimestamp} now={now} />

          <TokenCard
            tokenUsage={session.tokenUsage}
            tokenUsageDetails={session.tokenUsageDetails}
            isOpen={tokenOpen}
            onToggle={() => setTokenOpen(v => !v)}
          />

          <PipelineBar
            activeStep={session.activeStep}
            phase={session.phase}
            subTask={session.subTask}
            explanation={session.explanation}
          />

          <ConsoleLogs
            logs={session.consoleLogs}
            isOpen={logsOpen}
            onToggle={() => setLogsOpen(v => !v)}
          />

          <SessionHistory
            history={session.history}
            isOpen={historyOpen}
            onToggle={() => setHistoryOpen(v => !v)}
          />

          {/* Footer */}
          <p style={{ fontSize: 9.5, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8, lineHeight: 1.5 }}>
            Last updated: {data?.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString('en-US', { hour12: false }) : '—'}
          </p>
        </div>
      )}

      {/* ── Empty state ──────────────────────────────────────────────────── */}
      {!error && data && !session && (
        <div style={{ maxWidth: 540, padding: '0 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <p style={{ fontSize: 13 }}>No active session found in session_state.json.</p>
          <p style={{ fontSize: 11, marginTop: 6 }}>Start a conversation in Antigravity IDE.</p>
        </div>
      )}
    </div>
  );
}
