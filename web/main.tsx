/**
 * CWCC — Code While Claude Code. Preact SPA served by the daemon over ws://127.0.0.1:PORT.
 *
 * UI model (2026-07-19):
 *  - NO drill time pressure: a question lasts as long as Claude is working. A count-up chronometer shows
 *    the time spent on the current question; you answer (or skip) when ready.
 *  - Claude's working / finished state is a PROMINENT banner at the top of the play area.
 *  - When Claude finishes: a clear "Claude finished the task" screen → Keep playing / Back to Claude Code.
 *  - First visit: language modal (Python / Java), persisted, switchable in the header.
 *  - LeetCode-style question block, editor code card, A–D options resolving green/red, history panel.
 *
 * Guardrails: never steal focus; single-action; RESOLVING never yanks a question.
 */

import { render, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { RESULT_LINGER_MS } from '../src/shared/constants.js';
import type { ContentLang, Outcome, StatsUpdateMsg } from '../src/shared/protocol.js';
import { fsmReduce, initialFsmState, type FsmAction, type FsmState } from './fsm.js';
import { findItem, pickChallenge } from './games/registry.js';
import { evaluate, expectedAnswer, type Challenge } from './games/types.js';
import { connect, type WsClient } from './ws-client.js';

const LANG_KEY = 'cwcc.lang';
const RESULT_LINGER_LONG_MS = RESULT_LINGER_MS + 2000; // let the explanation breathe

const LANG_META: Record<ContentLang, { label: string; icon: string }> = {
  python: { label: 'Python', icon: '🐍' },
  java: { label: 'Java', icon: '☕' },
};

function storedLang(): ContentLang | null {
  const v = localStorage.getItem(LANG_KEY);
  return v === 'python' || v === 'java' ? v : null;
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function App() {
  const [state, setState] = useState<FsmState>(initialFsmState);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [answer, setAnswer] = useState('');
  const [stats, setStats] = useState<StatsUpdateMsg | null>(null);
  const [lang, setLang] = useState<ContentLang | null>(storedLang());
  const [now, setNow] = useState(Date.now());

  const wsRef = useRef<WsClient | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const challengeRef = useRef(challenge);
  challengeRef.current = challenge;
  const langRef = useRef(lang);
  langRef.current = lang;

  const dispatch = useCallback((action: FsmAction) => {
    setState((prev) => fsmReduce(prev, action, { now: Date.now() }));
  }, []);

  useEffect(() => {
    wsRef.current = connect({
      onOpen: () => dispatch({ kind: 'ws_open' }),
      onClose: () => dispatch({ kind: 'ws_close' }),
      onMessage: (msg) => {
        if (msg.type === 'stats_update') setStats(msg);
        dispatch({ kind: 'server', msg });
      },
    });
  }, [dispatch]);

  const chooseLang = (l: ContentLang) => {
    localStorage.setItem(LANG_KEY, l);
    setLang(l);
  };

  // New question mounts: pick content once (frozen for the drill; a language change applies next round).
  useEffect(() => {
    if (state.phase === 'ACTIVE' && state.challengeSeed !== null) {
      const l = langRef.current ?? 'python';
      setChallenge(pickChallenge(state.challengeSeed, state.difficulty, l));
      setSelected(null);
      setAnswer('');
    }
  }, [state.phase, state.challengeSeed, state.round, state.difficulty]);

  const resolve = useCallback(
    (outcome: Outcome) => {
      const st = stateRef.current;
      const ch = challengeRef.current;
      if (st.challengeSeed === null || !ch) return;
      if (st.phase !== 'ACTIVE' && st.phase !== 'RESOLVING') return;
      const ms = st.questionStartedAt !== null ? Math.max(0, Date.now() - st.questionStartedAt) : 0;
      wsRef.current?.send({
        type: 'challenge_result',
        mode: ch.kind,
        outcome,
        ms,
        seed: st.challengeSeed,
        itemId: ch.item.id,
      });
      dispatch({ kind: 'resolve', outcome, ms });
    },
    [dispatch],
  );

  // RESULT auto-advances after a linger (no time pressure on the question itself).
  useEffect(() => {
    if (state.phase !== 'RESULT') return;
    const linger = challenge?.kind === 'code' ? RESULT_LINGER_LONG_MS : RESULT_LINGER_MS;
    const t = setTimeout(() => dispatch({ kind: 'result_done' }), linger);
    return () => clearTimeout(t);
  }, [state.phase, challenge, dispatch]);

  // 1s tick to drive the count-up chronometer + "working for" banner.
  const ticking = state.turnActive || state.phase === 'ACTIVE' || state.phase === 'RESOLVING';
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [ticking]);

  // Keyboard: 1-9 / a-d pick an MCQ option; s skip; Esc back/stop; Enter continue on BREAK.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const st = stateRef.current;
      const ch = challengeRef.current;

      if (st.phase === 'BREAK') {
        if (e.key === 'Enter') dispatch({ kind: 'continue_play' });
        if (e.key === 'Escape') dispatch({ kind: 'stop_play' });
        return;
      }
      if (st.phase !== 'ACTIVE' && st.phase !== 'RESOLVING') return;
      if (e.key === 'Escape') {
        dispatch(st.phase === 'RESOLVING' ? { kind: 'dismiss' } : { kind: 'stop_play' });
        return;
      }
      if (e.key === 's' && st.phase === 'ACTIVE') {
        dispatch({ kind: 'skip' });
        return;
      }
      if (ch?.kind === 'mcq') {
        let idx = -1;
        const digit = Number(e.key);
        if (Number.isInteger(digit) && digit >= 1 && digit <= 9) idx = digit - 1;
        const letter = e.key.toLowerCase().charCodeAt(0) - 97; // a=0 … f=5
        if (e.key.length === 1 && letter >= 0 && letter < 6 && idx === -1) idx = letter;
        if (idx >= 0 && idx < ch.item.options.length) {
          setSelected(idx);
          resolve(idx === ch.item.answerIndex ? 'solved' : 'failed');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, resolve]);

  // Glanceable tab title.
  useEffect(() => {
    const base = 'CWCC — Code While Claude Code';
    document.title =
      state.phase === 'ACTIVE'
        ? `● drill — ${base}`
        : state.agentDone && (state.phase === 'RESOLVING' || state.phase === 'BREAK')
          ? `✓ Claude done — ${base}`
          : base;
  }, [state.phase, state.agentDone]);

  const questionMs =
    (state.phase === 'ACTIVE' || state.phase === 'RESOLVING') && state.questionStartedAt !== null
      ? now - state.questionStartedAt
      : state.phase === 'RESULT' && state.lastMs !== null
        ? state.lastMs
        : 0;
  const workingMs =
    state.turnActive && state.turnStartedAt !== null ? now - state.turnStartedAt : null;

  const playing =
    state.phase === 'ACTIVE' || state.phase === 'RESOLVING' || state.phase === 'RESULT';

  return (
    <div class="wrap">
      {lang === null && <LangModal onPick={chooseLang} />}

      <header>
        <div class="brand">
          <span class="logo">◆ CWCC</span>
          <span class="brand-sub">Code While Claude Code</span>
        </div>
        <span class="spacer" />
        {lang !== null && (
          <div class="lang-pills" role="group" aria-label="training language">
            {(Object.keys(LANG_META) as ContentLang[]).map((l) => (
              <button
                key={l}
                class={`pill ${lang === l ? 'pill-on' : ''}`}
                onClick={() => chooseLang(l)}
                title={`train in ${LANG_META[l].label}`}
              >
                {LANG_META[l].icon} {LANG_META[l].label}
              </button>
            ))}
          </div>
        )}
        {stats && stats.streak > 0 && (
          <span class="stat" title={`best streak: ${stats.best} days`}>
            🔥 {stats.streak}d
          </span>
        )}
        {stats && <span class="stat">today {stats.todaySolved}</span>}
      </header>

      {/* Prominent agent state banner — the thing the user asked to highlight. */}
      {playing && <AgentBanner state={state} workingMs={workingMs} freePlay={state.freePlay} />}

      {state.phase === 'DISCONNECTED' && (
        <Panel>
          <p class="muted">Connecting to the daemon…</p>
        </Panel>
      )}

      {state.phase === 'IDLE' && (
        <Panel>
          <h2>Waiting for Claude</h2>
          <p class="muted">
            A drill appears the moment your Claude Code turn goes busy, and stays for as long as
            Claude keeps working — no clock racing you. When Claude finishes, you choose: keep
            playing or head back to Claude Code.
          </p>
          <p class="muted kbd-hint">
            keys: <kbd>1</kbd>–<kbd>9</kbd> / <kbd>a</kbd>–<kbd>d</kbd> answer · <kbd>s</kbd> skip ·{' '}
            <kbd>esc</kbd> stop
          </p>
        </Panel>
      )}

      {state.phase === 'BREAK' && (
        <FinishedScreen
          onContinue={() => dispatch({ kind: 'continue_play' })}
          onStop={() => dispatch({ kind: 'stop_play' })}
        />
      )}

      {playing && challenge && (
        <GameCard
          state={state}
          challenge={challenge}
          selected={selected}
          answer={answer}
          setAnswer={setAnswer}
          questionMs={questionMs}
          onPickOption={(idx) => {
            if (state.phase !== 'ACTIVE' && state.phase !== 'RESOLVING') return;
            if (challenge.kind !== 'mcq') return;
            setSelected(idx);
            resolve(idx === challenge.item.answerIndex ? 'solved' : 'failed');
          }}
          onSubmitAnswer={() => {
            if (state.phase !== 'ACTIVE' && state.phase !== 'RESOLVING') return;
            if (challenge.kind !== 'code') return;
            resolve(evaluate(challenge.item.evaluator, answer) ? 'solved' : 'failed');
          }}
          onSkip={() => dispatch({ kind: 'skip' })}
          onNext={() => dispatch({ kind: 'result_done' })}
          onDismiss={() => dispatch({ kind: 'dismiss' })}
          onStop={() => dispatch({ kind: 'stop_play' })}
        />
      )}

      {stats && stats.recent.length > 0 && <HistoryPanel stats={stats} />}
    </div>
  );
}

function AgentBanner(props: { state: FsmState; workingMs: number | null; freePlay: boolean }) {
  const { state } = props;
  if (state.turnActive) {
    return (
      <div class="agent-banner banner-working">
        <span class="pulse-dot" />
        <span class="banner-text">Claude is working…</span>
        {props.workingMs !== null && <span class="banner-time">{fmtClock(props.workingMs)}</span>}
      </div>
    );
  }
  if (props.freePlay) {
    return (
      <div class="agent-banner banner-free">
        <span class="banner-text">🎮 Free play — Claude is idle</span>
      </div>
    );
  }
  if (state.agentDone) {
    return (
      <div class="agent-banner banner-done">
        <span class="banner-text">✓ Claude finished the task — wrap up this one</span>
      </div>
    );
  }
  return null;
}

function FinishedScreen(props: { onContinue: () => void; onStop: () => void }) {
  return (
    <section class="panel finished">
      <div class="finished-badge">✓</div>
      <h2>Claude finished the task</h2>
      <p class="muted">Keep the momentum going, or head back to your terminal.</p>
      <div class="break-actions">
        <button class="btn btn-primary" onClick={props.onContinue}>
          ▶ Keep playing <kbd>enter</kbd>
        </button>
        <button class="btn" onClick={props.onStop}>
          ← Back to Claude Code <kbd>esc</kbd>
        </button>
      </div>
    </section>
  );
}

function Panel(props: { children: ComponentChildren }) {
  return <section class="panel">{props.children}</section>;
}

function LangModal(props: { onPick: (l: ContentLang) => void }) {
  return (
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="choose language">
      <div class="modal">
        <span class="logo logo-big">◆ CWCC</span>
        <h2>Code While Claude Code</h2>
        <p class="muted">Pick the language you want to train in. You can change it anytime.</p>
        <div class="lang-choices">
          {(Object.keys(LANG_META) as ContentLang[]).map((l) => (
            <button key={l} class="lang-choice" onClick={() => props.onPick(l)}>
              <span class="lang-icon">{LANG_META[l].icon}</span>
              <span>{LANG_META[l].label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function GameCard(props: {
  state: FsmState;
  challenge: Challenge;
  selected: number | null;
  answer: string;
  setAnswer: (v: string) => void;
  questionMs: number;
  onPickOption: (idx: number) => void;
  onSubmitAnswer: () => void;
  onSkip: () => void;
  onNext: () => void;
  onDismiss: () => void;
  onStop: () => void;
}) {
  const { state, challenge } = props;
  const item = challenge.item;
  const done = state.phase === 'RESULT';

  return (
    <section class="panel game">
      <div class="challenge-head">
        <span class="chips">
          <span class={`chip chip-kind-${challenge.kind}`}>
            {challenge.kind === 'mcq' ? 'MCQ' : 'CODE'}
          </span>
          <span class="chip chip-lang">
            {LANG_META[item.lang].icon} {LANG_META[item.lang].label}
          </span>
          <span class={`chip chip-diff-${item.difficulty}`}>
            {item.difficulty === 'med' ? 'medium' : item.difficulty}
          </span>
          <span class="chip chip-round">Q{state.round + 1}</span>
        </span>
        {/* Count-up chronometer: time spent on THIS question. */}
        <span class={`chrono ${done ? 'chrono-frozen' : ''}`} title="time on this question">
          ⏱ {fmtClock(props.questionMs)}
        </span>
      </div>

      <div class="question">{item.prompt}</div>

      {item.code && (
        <pre class="code" aria-label="code snippet">
          {item.code.map((line, i) => (
            <div key={i} class="code-line">
              <span class="ln">{String(i + 1).padStart(2, ' ')}</span>
              <span class="src">{line || ' '}</span>
            </div>
          ))}
        </pre>
      )}

      {challenge.kind === 'mcq' && (
        <div class="options" role="group" aria-label="answer options">
          {challenge.item.options.map((opt, i) => {
            const isAnswer = i === challenge.item.answerIndex;
            const isSelected = i === props.selected;
            const cls = [
              'option',
              done && isAnswer ? 'option-correct' : '',
              done && isSelected && !isAnswer ? 'option-wrong' : '',
              !done && isSelected ? 'option-picked' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button key={i} class={cls} disabled={done} onClick={() => props.onPickOption(i)}>
                <span class="option-letter">{LETTERS[i] ?? i + 1}</span>
                <span class="option-text">{opt}</span>
                {done && isAnswer && <span class="option-mark">✓</span>}
                {done && isSelected && !isAnswer && <span class="option-mark">✗</span>}
              </button>
            );
          })}
        </div>
      )}

      {challenge.kind === 'code' && (
        <form
          class="answer-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmitAnswer();
          }}
        >
          <input
            class="answer-input"
            type="text"
            value={props.answer}
            placeholder={challenge.item.placeholder ?? 'your answer…'}
            disabled={done}
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => props.setAnswer((e.target as HTMLInputElement).value)}
          />
          <button
            class="btn btn-primary"
            type="submit"
            disabled={done || props.answer.trim() === ''}
          >
            Submit ⏎
          </button>
        </form>
      )}

      {!done && (
        <div class="game-foot">
          {state.phase === 'RESOLVING' ? (
            <button class="btn btn-small" onClick={props.onDismiss}>
              ← Back to Claude Code <kbd>esc</kbd>
            </button>
          ) : (
            <button class="btn-link" onClick={props.onSkip}>
              skip <kbd>s</kbd>
            </button>
          )}
        </div>
      )}

      {done && (
        <div class={`result result-${state.lastOutcome}`}>
          <div class="result-head">
            <span>{state.lastOutcome === 'solved' ? '✓ Correct' : '✗ Not quite'}</span>
            <span class="result-time">
              {state.lastOutcome === 'solved' ? 'solved' : 'answered'} in{' '}
              {fmtClock(props.questionMs)}
            </span>
          </div>
          {challenge.kind === 'code' && state.lastOutcome !== 'solved' && (
            <p class="expected">
              expected: <code>{expectedAnswer(challenge.item.evaluator)}</code>
            </p>
          )}
          <p class="explain">{item.explanation}</p>
          <div class="result-foot">
            <button class="btn btn-small" onClick={props.onNext}>
              Next question →
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function HistoryPanel(props: { stats: StatsUpdateMsg }) {
  return (
    <section class="panel history">
      <h3>Recent drills</h3>
      <ul>
        {props.stats.recent.map((r, i) => {
          const meta = r.itemId ? findItem(r.itemId) : null;
          const icon = r.outcome === 'solved' ? '✓' : r.outcome === 'timeout' ? '⏱' : '✗';
          return (
            <li key={`${r.ts}-${i}`} class={`hist hist-${r.outcome}`}>
              <span class={`hist-icon hist-icon-${r.outcome}`}>{icon}</span>
              <span class="hist-mode">{r.mode === 'code' ? 'CODE' : 'MCQ'}</span>
              {meta && <span class="hist-lang">{LANG_META[meta.lang].icon}</span>}
              <span class="hist-prompt">{meta ? meta.prompt : (r.itemId ?? '—')}</span>
              <span class="hist-ms">{(r.ms / 1000).toFixed(1)}s</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const CSS = `
:root {
  color-scheme: dark light;
  --bg: #101418; --panel: #181d23; --panel-2: #0d1117; --border: #2a313b; --text: #e8eaed;
  --muted: #99a3b0; --accent: #4ea1ff; --chip: #232a33; --hover: #232b35;
  --good: #00b8a3; --good-bg: rgba(0,184,163,.14);
  --bad: #ff375f; --bad-bg: rgba(255,55,95,.13);
  --warn: #ffc01e; --work: #4ea1ff; --work-bg: rgba(78,161,255,.14);
  --easy: #00b8a3; --med: #ffc01e; --hard: #ff375f;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f4f6f8; --panel: #ffffff; --panel-2: #f6f8fa; --border: #dfe3e8; --text: #1b1e22;
    --muted: #5a6472; --accent: #2472d6; --chip: #edf0f4; --hover: #e9eef5;
    --good: #00947f; --good-bg: rgba(0,148,127,.12);
    --bad: #d92049; --bad-bg: rgba(217,32,73,.10);
    --warn: #b58500; --work: #2472d6; --work-bg: rgba(36,114,214,.10);
    --easy: #00947f; --med: #b58500; --hard: #d92049;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); }
.wrap {
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  max-width: 760px; margin: 0 auto; padding: 1.4rem 1rem 3rem; color: var(--text); min-height: 100vh;
}
header { display: flex; align-items: center; gap: .7rem; margin-bottom: 1rem; flex-wrap: wrap; }
.brand { display: flex; flex-direction: column; line-height: 1.15; }
.logo { font-weight: 800; letter-spacing: .04em; }
.logo-big { font-size: 1.4rem; }
.brand-sub { font-size: .68rem; color: var(--muted); letter-spacing: .02em; }
.spacer { flex: 1; }
.stat { font-size: .8rem; opacity: .85; }
.lang-pills { display: flex; gap: .3rem; }
.pill {
  font: inherit; font-size: .78rem; padding: .22rem .6rem; border-radius: 999px; cursor: pointer;
  background: var(--chip); color: var(--muted); border: 1px solid transparent;
}
.pill-on { color: var(--text); border-color: var(--accent); background: var(--panel); }

/* Prominent agent-state banner */
.agent-banner {
  display: flex; align-items: center; gap: .7rem; padding: .7rem 1rem; margin-bottom: 1rem;
  border-radius: 12px; font-weight: 700; font-size: 1rem; border: 1px solid transparent;
}
.banner-working { background: var(--work-bg); color: var(--work); border-color: var(--work); }
.banner-done { background: var(--good-bg); color: var(--good); border-color: var(--good); }
.banner-free { background: var(--chip); color: var(--muted); }
.banner-text { flex: 1; }
.banner-time { font-variant-numeric: tabular-nums; font-size: 1.05rem; }
.pulse-dot {
  width: .7rem; height: .7rem; border-radius: 50%; background: var(--work);
  box-shadow: 0 0 0 0 var(--work); animation: pulse 1.6s infinite;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(78,161,255,.5); }
  70% { box-shadow: 0 0 0 .6rem rgba(78,161,255,0); }
  100% { box-shadow: 0 0 0 0 rgba(78,161,255,0); }
}

.panel {
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 1.15rem 1.25rem; box-shadow: 0 2px 8px rgba(0,0,0,.14); margin-bottom: 1rem;
}
.muted { color: var(--muted); }
h2 { margin: 0 0 .4rem; font-size: 1.12rem; }
h3 { margin: 0 0 .6rem; font-size: .95rem; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
kbd {
  font: inherit; font-size: .72em; padding: .05em .4em; border: 1px solid var(--border);
  border-bottom-width: 2px; border-radius: 4px; background: var(--chip);
}
.kbd-hint { font-size: .8rem; margin-top: .8rem; }
.btn {
  font: inherit; padding: .5rem .95rem; border-radius: 9px; cursor: pointer;
  background: var(--chip); color: var(--text); border: 1px solid var(--border);
}
.btn:hover { background: var(--hover); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { filter: brightness(1.08); background: var(--accent); }
.btn-primary:disabled { opacity: .5; cursor: default; }
.btn-small { padding: .3rem .7rem; font-size: .82rem; }
.btn-link { font: inherit; background: none; border: none; color: var(--muted); cursor: pointer; padding: .3rem; }
.btn-link:hover { color: var(--text); }

.finished { text-align: center; padding: 1.6rem 1.25rem; }
.finished-badge {
  width: 3rem; height: 3rem; margin: 0 auto .6rem; border-radius: 50%; display: grid; place-items: center;
  font-size: 1.5rem; font-weight: 800; color: #fff; background: var(--good);
}
.break-actions { display: flex; gap: .7rem; justify-content: center; margin-top: 1.1rem; flex-wrap: wrap; }

.challenge-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: .7rem; gap: .5rem; }
.chips { display: flex; gap: .35rem; flex-wrap: wrap; }
.chip {
  font-size: .68rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
  padding: .18rem .5rem; border-radius: 999px; background: var(--chip); color: var(--muted);
}
.chip-kind-mcq { background: rgba(78,161,255,.16); color: var(--accent); }
.chip-kind-code { background: rgba(155,109,255,.18); color: #9b6dff; }
.chip-diff-easy { background: var(--good-bg); color: var(--easy); }
.chip-diff-med { background: rgba(255,192,30,.15); color: var(--med); }
.chip-diff-hard { background: var(--bad-bg); color: var(--hard); }
.chrono {
  font-variant-numeric: tabular-nums; font-weight: 800; font-size: 1.05rem; color: var(--text);
  background: var(--chip); padding: .2rem .6rem; border-radius: 8px;
}
.chrono-frozen { opacity: .6; }
.question {
  font-size: 1.02rem; font-weight: 600; padding: .55rem .8rem; margin-bottom: .7rem;
  border-left: 3px solid var(--accent); background: var(--chip); border-radius: 0 10px 10px 0;
}
.code {
  margin: 0 0 .8rem; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: .87rem; line-height: 1.6; overflow-x: auto;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: .6rem .3rem;
}
.code-line { display: flex; gap: .85rem; padding: 0 .5rem; white-space: pre; }
.ln { opacity: .38; user-select: none; text-align: right; min-width: 1.4em; border-right: 1px solid var(--border); padding-right: .5rem; }
.options { display: grid; gap: .5rem; grid-template-columns: 1fr; }
@media (min-width: 560px) { .options { grid-template-columns: 1fr 1fr; } }
.option {
  display: flex; align-items: center; gap: .6rem; text-align: left; font: inherit; cursor: pointer;
  padding: .6rem .7rem; border-radius: 10px; border: 1.5px solid var(--border);
  background: var(--panel); color: var(--text); transition: border-color .12s, background .12s;
}
.option:hover:not(:disabled) { border-color: var(--accent); background: var(--hover); }
.option:disabled { cursor: default; }
.option-letter {
  flex: none; width: 1.5rem; height: 1.5rem; border-radius: 50%; display: grid; place-items: center;
  font-size: .75rem; font-weight: 800; background: var(--chip); color: var(--muted);
}
.option-text { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .85rem; }
.option-mark { margin-left: auto; font-weight: 800; }
.option-correct { border-color: var(--good); background: var(--good-bg); }
.option-correct .option-letter { background: var(--good); color: #fff; }
.option-correct .option-mark { color: var(--good); }
.option-wrong { border-color: var(--bad); background: var(--bad-bg); }
.option-wrong .option-letter { background: var(--bad); color: #fff; }
.option-wrong .option-mark { color: var(--bad); }
.option-picked { border-color: var(--accent); }
.answer-form { display: flex; gap: .5rem; }
.answer-input {
  flex: 1; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .9rem;
  padding: .55rem .7rem; border-radius: 9px; border: 1.5px solid var(--border);
  background: var(--panel-2); color: var(--text);
}
.answer-input:focus { outline: none; border-color: var(--accent); }
.game-foot { display: flex; justify-content: flex-end; margin-top: .8rem; }
.result { margin-top: .95rem; padding: .7rem .8rem; border-radius: 10px; }
.result-solved { background: var(--good-bg); }
.result-failed, .result-timeout { background: var(--bad-bg); }
.result-head { display: flex; justify-content: space-between; align-items: baseline; font-weight: 800; font-size: 1rem; }
.result-solved .result-head > span:first-child { color: var(--good); }
.result-failed .result-head > span:first-child, .result-timeout .result-head > span:first-child { color: var(--bad); }
.result-time { font-size: .8rem; font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; }
.expected { margin: .3rem 0 0; font-size: .85rem; }
.expected code { background: var(--panel-2); padding: .1rem .4rem; border-radius: 5px; }
.explain { margin: .35rem 0 .2rem; font-size: .88rem; opacity: .92; }
.result-foot { display: flex; justify-content: flex-end; margin-top: .5rem; }
.history ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.hist { display: flex; align-items: center; gap: .55rem; font-size: .84rem; padding: .3rem .4rem; border-radius: 8px; }
.hist:hover { background: var(--hover); }
.hist-icon { font-weight: 800; width: 1rem; text-align: center; }
.hist-icon-solved { color: var(--good); }
.hist-icon-failed { color: var(--bad); }
.hist-icon-timeout { color: var(--muted); }
.hist-mode { font-size: .64rem; font-weight: 800; letter-spacing: .05em; background: var(--chip); color: var(--muted); padding: .1rem .4rem; border-radius: 999px; }
.hist-prompt { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
.hist-ms { font-variant-numeric: tabular-nums; color: var(--muted); font-size: .78rem; }
.modal-overlay {
  position: fixed; inset: 0; background: rgba(8, 10, 14, .66); backdrop-filter: blur(3px);
  display: grid; place-items: center; z-index: 10;
}
.modal {
  background: var(--panel); border: 1px solid var(--border); border-radius: 16px;
  padding: 1.6rem 1.8rem; max-width: 380px; width: calc(100% - 2rem); text-align: center;
  box-shadow: 0 18px 50px rgba(0,0,0,.4);
}
.lang-choices { display: flex; gap: .8rem; margin-top: 1.1rem; }
.lang-choice {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: .35rem; cursor: pointer;
  font: inherit; font-weight: 700; padding: 1rem .5rem; border-radius: 12px;
  border: 1.5px solid var(--border); background: var(--panel-2); color: var(--text);
  transition: border-color .12s, transform .12s;
}
.lang-choice:hover { border-color: var(--accent); transform: translateY(-2px); }
.lang-icon { font-size: 1.7rem; }
@media (prefers-reduced-motion: reduce) {
  .option, .lang-choice, .btn { transition: none; }
  .lang-choice:hover { transform: none; }
  .pulse-dot { animation: none; }
}
`;

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

const root = document.getElementById('app');
if (root) render(<App />, root);
