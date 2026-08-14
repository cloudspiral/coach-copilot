import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CartesianGrid, Line, LineChart, Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartSpec, DecisionTrace, EvidenceRecord, ModelCallTrace, WorkoutPlan } from "../shared/schemas";

const memberId = "mbr_01HX9JORDAN";

interface MemberPayload {
  coach: { id: string; name: string };
  member: { id: string; name: string; age: number; tier: string; goal: string; knee: string; equipment: string[]; adherence: number; adherenceTrend: string; churnRisk: string };
  graph: { nodes: number; edges: number };
}

interface HealthPayload { apiKeyConfigured: boolean; model: string; graphReady: boolean }
interface WorkoutPayload {
  status: "ready" | "needs_clarification";
  mode: "live" | "deterministic_fallback";
  model: string;
  modelCallCount: number;
  traceId: string;
  clarification?: string;
  warnings: string[];
  plan: WorkoutPlan | null;
  decisions: DecisionTrace[];
  evidence: EvidenceRecord[];
  modelCalls: ModelCallTrace[];
}
interface CopilotPayload {
  status: "ready";
  mode: "live" | "deterministic_fallback";
  model: string;
  modelCallCount: number;
  traceId: string;
  conversationId: string;
  topic: string;
  topics: string[];
  answer: { headline: string; narrative: Array<{ text: string; evidenceIds: string[] }>; followUpSuggestion: string };
  chart: ChartSpec | null;
  attachments: Array<{ type: string; caption: string }>;
  evidence: EvidenceRecord[];
  modelCalls: ModelCallTrace[];
}
interface ChatEntry { role: "coach" | "copilot"; message: string; response?: CopilotPayload }

const quickPrompts = ["Show me the brief", "Plot adherence trend", "How has her sleep been this week?", "Is she at risk of churning?", "What was her latest workout?", "Summarize her latest labs"];

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

function ModeBadge({ mode, model, count }: { mode: "live" | "deterministic_fallback"; model: string; count?: number }) {
  return <span className={`mode-badge ${mode === "live" ? "live" : "fallback"}`} data-testid="mode-badge">
    <span className="status-dot" />{mode === "live" ? "Live" : "Fallback"} · {model}{count !== undefined ? ` · ${count} calls` : ""}
  </span>;
}

function EvidenceDetails({ ids, evidence }: { ids: string[]; evidence: EvidenceRecord[] }) {
  const items = ids.flatMap((id) => {
    const evidenceIndex = evidence.findIndex((item) => item.id === id);
    return evidenceIndex === -1 ? [] : [{ item: evidence[evidenceIndex], citationNumber: evidenceIndex + 1 }];
  });
  return <div className="citation-row">
    {items.map(({ item, citationNumber }) => <details className="citation" key={item.id} data-testid="citation">
      <summary aria-label={`Open citation ${citationNumber}: ${item.title}`}>[{citationNumber}]</summary>
      <div className="evidence-popover">
        <strong>{item.title}</strong>
        <p>{item.detail}</p>
        <dl>
          <div><dt>Source</dt><dd>{item.sourceLabel}</dd></div>
          {item.timestamp && <div><dt>Date</dt><dd>{item.timestamp}</dd></div>}
          {item.jsonPointer && <div><dt>JSON pointer</dt><dd><code>{item.jsonPointer}</code></dd></div>}
          {item.graphPath && <div><dt>Graph path</dt><dd>{item.graphPath.join(" → ")}</dd></div>}
          {item.ruleId && <div><dt>Rule</dt><dd>{item.ruleId}</dd></div>}
        </dl>
      </div>
    </details>)}
  </div>;
}

function ChartView({ chart }: { chart: ChartSpec }) {
  const common = <>
    <CartesianGrid stroke="#2b3c37" strokeDasharray="4 4" />
    <XAxis dataKey={Object.keys(chart.data[0] ?? {})[0]} tick={{ fill: "#9fb0aa", fontSize: 12 }} />
    <YAxis tick={{ fill: "#9fb0aa", fontSize: 12 }} />
    <Tooltip contentStyle={{ background: "#14201d", border: "1px solid #3e544d", borderRadius: 10 }} />
  </>;
  return <div className="chart-card" data-testid="chart">
    <div><span className="eyebrow">TREND</span><h4>{chart.title}</h4></div>
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        {chart.type === "line" ? <LineChart data={chart.data}>{common}{chart.series.map((series) => <Line key={series.name} dataKey={series.name} stroke={series.color} strokeWidth={3} dot={{ r: 5 }} />)}</LineChart>
          : <BarChart data={chart.data}>{common}{chart.series.map((series) => <Bar key={series.name} dataKey={series.name} fill={series.color} radius={[5, 5, 0, 0]} />)}</BarChart>}
      </ResponsiveContainer>
    </div>
    <div className="chart-data" aria-label="Chart data">{chart.data.map((point, index) => <span key={index}>{Object.values(point).join(": ")}</span>)}</div>
  </div>;
}

function WorkoutSurface() {
  const [prompt, setPrompt] = useState("Create a 30-minute lower-body workout for Jordan. Go easy on her left knee.");
  const [duration, setDuration] = useState(30);
  const [adjustment, setAdjustment] = useState("");
  const [result, setResult] = useState<WorkoutPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function generate(event?: FormEvent) {
    event?.preventDefault();
    setLoading(true);
    setError("");
    try {
      const isAdjustment = Boolean(adjustment.trim() && result?.plan);
      const payload = await postJson<WorkoutPayload>("/api/workouts/generate", {
        memberId,
        prompt: isAdjustment ? adjustment : prompt,
        durationMinutes: duration,
        basePlanId: isAdjustment ? result?.plan?.id : undefined,
      });
      setResult(payload);
      if (isAdjustment && payload.status === "ready") setAdjustment("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to generate the workout");
    } finally {
      setLoading(false);
    }
  }

  const exclusions = result?.decisions.filter((decision) => decision.decision === "excluded").slice(0, 10) ?? [];
  return <section className="surface" aria-labelledby="workout-heading">
    <div className="surface-heading">
      <div><span className="eyebrow">CONSTRAINT-FIRST PROGRAMMING</span><h2 id="workout-heading">Workout Generator</h2><p>Build from Jordan's graph, then let AI explain—not decide.</p></div>
      {result && <ModeBadge mode={result.mode} model={result.model} count={result.modelCallCount} />}
    </div>
    <div className="workout-grid">
      <form className="composer-card" onSubmit={generate}>
        <label htmlFor="workout-prompt">What should Jordan train?</label>
        <textarea id="workout-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
        <fieldset><legend>Duration</legend><div className="duration-options">{[15, 30, 45, 60].map((minutes) => <button aria-pressed={duration === minutes} className={duration === minutes ? "selected" : ""} key={minutes} onClick={() => setDuration(minutes)} type="button">{minutes} min</button>)}</div></fieldset>
        <div className="constraint-strip"><span>✓ Home equipment only</span><span>✓ Knee graph active</span><span>✓ Duration locked</span></div>
        <button className="primary" disabled={loading} type="submit">{loading ? <><span className="spinner" />Building a safe plan…</> : "Generate workout"}</button>
        {result?.plan && <div className="adjustment-box">
          <label htmlFor="adjustment">Adjust this plan</label>
          <div><input id="adjustment" placeholder="e.g. Exclude deadlifts and similar moves" value={adjustment} onChange={(event) => setAdjustment(event.target.value)} /><button disabled={loading || !adjustment.trim()} type="submit">Recompute</button></div>
          <small>Adjustments rerun graph selection; they never patch the plan.</small>
        </div>}
      </form>

      <div className="results-column" aria-live="polite">
        {!result && !loading && <div className="empty-state"><div className="empty-icon">↗</div><h3>Your plan will appear here</h3><p>Safety and equipment constraints are enforced before the response is written.</p></div>}
        {loading && <div className="loading-card"><span className="spinner large" /><h3>Traversing Jordan's graph</h3><p>Resolving intent, filtering constraints, and assembling phases…</p></div>}
        {error && <div className="alert error" role="alert"><strong>Generation failed</strong><p>{error}</p><button onClick={() => generate()} type="button">Try again</button></div>}
        {result?.status === "needs_clarification" && <div className="alert clarification" data-testid="clarification"><strong>One detail needs clarification</strong><p>{result.clarification}</p><div className="trace-line"><span data-testid="model-call-count">modelCallCount={result.modelCallCount}</span></div></div>}
        {result?.plan && <div className="plan" data-testid="workout-plan">
          <div className="plan-title"><div><span className="eyebrow">READY TO COACH</span><h3>{result.plan.title}</h3></div><div className="plan-duration"><strong>{result.plan.totalMinutes}</strong><span>minutes</span></div></div>
          <div className="safety-banner"><span>◉</span><div><strong>Knee-aware by construction</strong><p>{result.plan.safetyNotes.join(" ")}</p></div></div>
          {result.warnings.map((warning) => <div className="alert clarification" key={warning}>{warning}</div>)}
          {result.plan.sections.map((section) => <div className="plan-section" key={section.phase}>
            <div className="section-title"><span>{section.phase === "warmup" ? "01" : section.phase === "main" ? "02" : "03"}</span><h4>{section.title}</h4><em>{section.minutes} min</em></div>
            {section.exercises.map((exercise) => <article className="exercise-card" key={`${section.phase}-${exercise.exerciseId}`}>
              <div className="exercise-main"><div className={`risk-dot ${exercise.riskLevel}`} /><div><h5>{exercise.name}</h5><p>{exercise.sets} set{exercise.sets === 1 ? "" : "s"}{exercise.reps ? ` · ${exercise.reps}` : ""}{exercise.durationSeconds ? ` · ${exercise.durationSeconds}s` : ""} · {exercise.restSeconds}s rest</p></div><span className="exercise-time">{exercise.estimatedMinutes}m</span></div>
              <p className="instruction">{exercise.instructions}</p>
              {exercise.requiredEquipment.length > 0 && <div className="chips">{exercise.requiredEquipment.map((item) => <span key={item}>{item}</span>)}</div>}
              <details className="why"><summary>Why this exercise?</summary><p>{result.decisions.find((decision) => decision.exerciseId === exercise.exerciseId)?.reason}</p><EvidenceDetails ids={exercise.evidenceIds} evidence={result.evidence} /></details>
            </article>)}
          </div>)}
          <details className="exclusions" open><summary><span>Excluded by constraints</span><strong>{exclusions.length}</strong></summary><div>{exclusions.map((decision) => <div className="excluded-row" key={decision.exerciseId}><span>×</span><div><strong>{decision.exerciseName}</strong><p>{decision.reason}</p><EvidenceDetails ids={decision.evidenceIds} evidence={result.evidence} /></div></div>)}</div></details>
          <div className="trace-line">Trace {result.traceId.slice(0, 8)} · <span data-testid="model-call-count">modelCallCount={result.modelCallCount}</span></div>
        </div>}
      </div>
    </div>
  </section>;
}

function CopilotSurface() {
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const latest = [...history].reverse().find((entry) => entry.response)?.response;

  async function ask(message = input) {
    if (!message.trim() || loading) return;
    setHistory((entries) => [...entries, { role: "coach", message }]);
    setInput("");
    setLoading(true);
    setError("");
    try {
      const response = await postJson<CopilotPayload>("/api/copilot/query", { memberId, message, conversationId });
      setConversationId(response.conversationId);
      setHistory((entries) => [...entries, { role: "copilot", message: response.answer.headline, response }]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Copilot request failed");
    } finally {
      setLoading(false);
    }
  }

  return <section className="surface" aria-labelledby="copilot-heading">
    <div className="surface-heading"><div><span className="eyebrow">GROUNDed MEMBER INTELLIGENCE</span><h2 id="copilot-heading">Coach AI Copilot</h2><p>Ask across Jordan's supplied history. Every material claim opens to its source.</p></div>{latest && <ModeBadge mode={latest.mode} model={latest.model} count={latest.modelCallCount} />}</div>
    <div className="copilot-layout">
      <aside className="prompt-palette"><h3>Start with a question</h3>{quickPrompts.map((prompt) => <button key={prompt} onClick={() => ask(prompt)} type="button"><span>↗</span>{prompt}</button>)}<div className="data-scope"><strong>Available data</strong><p>Workouts · adherence · sleep · labs · DEXA · chats · attachments</p></div></aside>
      <div className="chat-panel">
        <div className="chat-history" data-testid="chat-history">
          {history.length === 0 && <div className="copilot-welcome"><div className="orb">C</div><h3>What do you need to know?</h3><p>I retrieve Jordan's evidence first, compute results in code, and cite each answer.</p></div>}
          {history.map((entry, index) => entry.role === "coach" ? <div className="message coach-message" key={index}><span>You</span><p>{entry.message}</p></div> : entry.response && <div className="message copilot-message" key={index} data-testid="copilot-answer">
            <div className="answer-header"><div className="mini-orb">C</div><div><span>Coach Copilot</span><h3>{entry.response.answer.headline}</h3></div></div>
            <div className="answer-narrative">{entry.response.answer.narrative.map((item, itemIndex) => <div className="narrative-line" key={itemIndex}><p>{item.text}</p><EvidenceDetails ids={item.evidenceIds} evidence={entry.response!.evidence} /></div>)}</div>
            {entry.response.chart && <ChartView chart={entry.response.chart} />}
            {entry.response.attachments.map((attachment, attachmentIndex) => <div className="attachment" key={attachmentIndex}><div>▧</div><span><strong>{attachment.caption}</strong><small>Synthetic placeholder · no image file supplied</small></span></div>)}
            <button className="followup" onClick={() => setInput(entry.response!.answer.followUpSuggestion)} type="button">↳ {entry.response.answer.followUpSuggestion}</button>
            <div className="trace-line">{entry.response.topics.length > 1 ? "Topics" : "Topic"} {entry.response.topics.join(", ")} · Trace {entry.response.traceId.slice(0, 8)} · <span data-testid="model-call-count">modelCallCount={entry.response.modelCallCount}</span></div>
          </div>)}
          {loading && <div className="message copilot-message loading-message"><span className="spinner" />Retrieving evidence and composing…</div>}
          {error && <div className="alert error" role="alert">{error}</div>}
        </div>
        <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void ask(); }}><textarea aria-label="Ask Coach Copilot" placeholder="Ask about Jordan's adherence, sleep, labs, workouts…" rows={2} value={input} onChange={(event) => setInput(event.target.value)} /><button aria-label="Send question" disabled={loading || !input.trim()} type="submit">↑</button></form>
        <p className="composer-note">Synthetic member data only · Responses are coaching support, not medical advice</p>
      </div>
    </div>
  </section>;
}

export function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [surface, setSurface] = useState<"workout" | "copilot">("workout");
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [member, setMember] = useState<MemberPayload | null>(null);

  useEffect(() => {
    Promise.all([fetch("/api/health").then((response) => response.json()), fetch("/api/member").then((response) => response.json())])
      .then(([healthPayload, memberPayload]) => { setHealth(healthPayload as HealthPayload); setMember(memberPayload as MemberPayload); })
      .catch(() => undefined);
  }, []);

  const initialMode = useMemo(() => health?.apiKeyConfigured ? "live" : "deterministic_fallback", [health]);
  if (!loggedIn) return <main className="login-screen">
    <div className="login-noise" />
    <div className="login-card"><div className="brand-mark">CC</div><span className="eyebrow">COACH OPERATING SYSTEM</span><h1>Coach with context.<br /><em>Move with confidence.</em></h1><p>A constraint-aware workout builder and evidence-grounded member copilot, using only Jordan's fictional record.</p><button className="primary login-button" onClick={() => setLoggedIn(true)} type="button"><span className="avatar">S</span>Continue as Sam <b>→</b></button><small>Local MVP · no real member data</small></div>
  </main>;

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark small">CC</span><div><strong>Coach Copilot</strong><small>Sam's workspace</small></div></div><nav aria-label="Product surfaces"><button className={surface === "workout" ? "active" : ""} onClick={() => setSurface("workout")} type="button">Workout Generator</button><button className={surface === "copilot" ? "active" : ""} onClick={() => setSurface("copilot")} type="button">AI Copilot</button></nav><div className="header-actions">{health && <ModeBadge mode={initialMode} model={health.model} />}<span className="avatar">S</span></div></header>
    <aside className="member-rail">
      <div className="member-identity"><div className="member-avatar">JR</div><div><span>COACHING</span><strong>{member?.member.name ?? "Jordan Rivera"}</strong><small>{member?.member.tier ?? "1:1 Coaching"}</small></div></div>
      <div className="member-signal"><span>PRIMARY GOAL</span><strong>{member?.member.goal ?? "Build lower-body strength"}</strong></div>
      <div className="metric"><span>Adherence</span><strong>{member?.member.adherence ?? 50}%</strong><em className="down">↓ declining</em></div>
      <div className="metric"><span>Left knee</span><strong>Recovering</strong><em className="safe">Low-impact</em></div>
      <div className="metric"><span>Churn risk</span><strong className="risk">{member?.member.churnRisk ?? "elevated"}</strong><em>supplied</em></div>
      <details className="equipment-list"><summary>Equipment · {member?.member.equipment.length ?? 5}</summary>{member?.member.equipment.map((item) => <span key={item}>{item}</span>)}</details>
      <div className="graph-status"><span className="status-dot" /><div><strong>Knowledge graph ready</strong><small>{member?.graph.nodes ?? "—"} nodes · {member?.graph.edges ?? "—"} edges</small></div></div>
    </aside>
    <main className="main-content">{surface === "workout" ? <WorkoutSurface /> : <CopilotSurface />}</main>
  </div>;
}
