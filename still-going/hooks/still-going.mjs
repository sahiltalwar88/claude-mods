// still-going: is Claude working, waiting on something, or stopped?
// Drawn above the prompt (terminal, desktop); /going prints the same lines anywhere.

const RUN = { plugin: "still-going", key: "run" };
const LIVE = { plugin: "still-going", key: "live" };
const POLL_MS = 5000;
const STALE_MS = 3 * 60 * 1000;
// Headless captures from any session on this machine.
const CAPTURE_PATTERN = "^node (\\S*/)?scripts/(shoot|page-shot|load-time|leader-check)\\.cjs";

const IDLE = { isWorking: false, turnStartedAt: 0, lastActionAt: 0, lastAction: "", endedAt: 0, wasAborted: false };

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await $.command.register({ name: "going", description: "Is Claude working, waiting, or stopped?", immediate: true });
    await poll($);
    $.clock.every(POLL_MS, () => poll($));
    return result;
  });

  on("turn.start", async ($, e, next) => {
    const now = await $.clock.now();
    await $.state.set(RUN, { ...IDLE, isWorking: true, turnStartedAt: now, lastActionAt: now, lastAction: "reading your message" });
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    if (!e.agentId) {
      const { value: run = IDLE } = await $.state.get(RUN);
      await $.state.set(RUN, { ...run, lastActionAt: await $.clock.now(), lastAction: describe(e) });
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) {
      const { value: run = IDLE } = await $.state.get(RUN);
      await $.state.set(RUN, { ...run, isWorking: false, endedAt: await $.clock.now(), wasAborted: e.isAborted });
    }
    return result;
  });

  on("command.run", { command: "going" }, async ($) => ({ text: (await lines($)).map((l) => l.map((p) => p.text).join("")).join("\n") }));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const rows = await lines($);
    const { Box, Text } = $.ui.resolve(e);
    return Box({
      flexDirection: "column",
      paddingX: 1,
      children: rows.map((parts) =>
        Box({ flexDirection: "row", children: parts.map((p) => Text({ color: p.color, dimColor: p.dim, bold: p.bold, wrap: "truncate-end", children: p.text })) }),
      ),
    });
  });
}

async function poll($) {
  const now = await $.clock.now();
  const { value: prev } = await $.state.get(LIVE);
  const seen = new Map((prev?.agents ?? []).map((a) => [a.id, a.firstSeen]));
  const agents = (await $.agent.list())
    .filter((a) => a.status === "running")
    .map((a) => ({ id: a.id, label: a.name ?? a.description ?? a.type, firstSeen: seen.get(a.id) ?? now }));

  let captures = [];
  try {
    const { stdout } = await $.process.run(["pgrep", "-af", CAPTURE_PATTERN], { timeoutMs: 3000 });
    captures = stdout.split("\n").filter((l) => l.trim()).map(captureName);
  } catch {}

  let freeGb = null;
  try {
    const m = /MemAvailable:\s+(\d+)/.exec(await $.fs.read("/proc/meminfo"));
    if (m) freeGb = Number(m[1]) / 1024 / 1024;
  } catch {}

  await $.state.set(LIVE, { at: now, agents, captures, freeGb });
}

async function lines($) {
  const now = await $.clock.now();
  const { value: run = IDLE } = await $.state.get(RUN);
  const { value: live = { agents: [], captures: [], freeGb: null } } = await $.state.get(LIVE);
  const waiting = live.agents.length + live.captures.length > 0;

  const head = [];
  if (run.isWorking) {
    const quiet = now - run.lastActionAt;
    head.push({ text: "● working", color: "green", bold: true });
    head.push({ text: `  ${ago(now - run.turnStartedAt)} into this turn`, dim: true });
    if (quiet > STALE_MS) head.push({ text: `  ⏱ ${ago(quiet)} since last action`, color: "yellow", bold: true });
    else head.push({ text: `  last: ${run.lastAction} (${ago(quiet)} ago)`, dim: true });
  } else if (run.endedAt === 0) {
    head.push({ text: "○ no turn yet this session", dim: true });
  } else if (waiting) {
    head.push({ text: "◐ turn ended, still running in background", color: "cyan", bold: true });
    head.push({ text: `  ${ago(now - run.endedAt)} ago`, dim: true });
  } else {
    head.push({ text: run.wasAborted ? "■ stopped: you interrupted" : "■ turn ended, nothing running", color: "red", bold: true });
    head.push({ text: `  ${ago(now - run.endedAt)} ago`, dim: true });
  }

  const tail = [];
  for (const a of live.agents) tail.push({ text: `agent: ${a.label} ${ago(now - a.firstSeen)}   ` });
  for (const c of live.captures) tail.push({ text: `capture: ${c}   `, color: "magenta" });
  if (live.freeGb !== null) tail.push({ text: `RAM ${live.freeGb.toFixed(1)}G free`, color: live.freeGb < 2 ? "red" : undefined, dim: live.freeGb >= 2 });

  return tail.length ? [head, tail] : [head];
}

function describe(e) {
  if (e.tool === "Bash") return `Bash: ${String(e.description ?? e.command ?? "").slice(0, 50)}`;
  if (e.tool === "Agent") return `Agent: ${String(e.description ?? "")}`;
  const path = e.file_path ?? e.path ?? e.pattern;
  return path ? `${e.tool}: ${String(path).split("/").pop()}` : e.tool;
}

function captureName(line) {
  const png = /(\S+\.png)/.exec(line);
  return png ? png[1].split("/").pop() : line.slice(line.indexOf(" ") + 1, 40);
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
