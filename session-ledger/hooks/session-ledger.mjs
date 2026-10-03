// session-ledger: what this session changed, filed under the request that caused it,
// and whether each change was checked, committed, or touched again by someone else.
// /ledger prints it anywhere and opens it as a pane where panes are drawn.

const REQUESTS = { plugin: "session-ledger", key: "requests" };
const PANE = "ledger";
const SHOWN = 8;
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const CHECKS = [
  [/astro build/, "build"],
  [/npm run probe/, "probe"],
  [/npm run shot:page/, "page capture"],
  [/npm run shot\b(?!:)/, "capture"],
  [/knob-doc\.py --check/, "knob doc"],
  [/\b(vitest|npm (run )?test|tsc\b|astro check)/, "tests"],
];
// Someone else wrote the file if its mtime is this far past our last write.
const FOREIGN_MS = 3000;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await $.command.register({ name: "ledger", description: "What this session changed, per request: checked, committed, or not", immediate: true });
    return result;
  });

  on("turn.start", async ($, e, next) => {
    const ask = e.text.trim();
    if (ask && !ask.startsWith("/")) {
      const { value: requests = [] } = await $.state.get(REQUESTS);
      const first = ask.split("\n").find((l) => l.trim()) ?? ask;
      await $.state.set(REQUESTS, [...requests, { ask: clip(first, 90), at: await $.clock.now(), files: [], checks: [], commits: [] }]);
    }
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (result.deny) return result;
    if (EDIT_TOOLS.has(e.tool) && !result.isError) {
      const path = String(e.file_path ?? e.notebook_path ?? "");
      if (path) await record($, (r, now, by) => ({ ...r, files: [...r.files.filter((f) => f.path !== path), { path, by, at: now }] }), e.agentId);
    } else if (e.tool === "Bash") {
      const command = String(e.command ?? "");
      const check = CHECKS.find(([re]) => re.test(command));
      if (check && !result.result?.backgroundTaskId) {
        await record($, (r, now) => ({ ...r, checks: [...r.checks, { what: check[1], ok: !result.isError, at: now }] }), e.agentId);
      }
      if (/\bgit commit\b/.test(command) && !result.isError) {
        const { stdout } = await $.process.run(["git", "log", "-1", "--format=%h%x09%s"]);
        const [hash, subject = ""] = stdout.trim().split("\t");
        if (hash) await record($, (r, now) => ({ ...r, commits: [...r.commits.filter((c) => c.subject !== subject), { hash, subject, at: now }] }), e.agentId);
      }
    }
    return result;
  });

  on("command.run", { command: "ledger" }, async ($) => {
    await $.ui.open({ id: PANE, title: "Ledger" });
    const rows = await build($);
    return { text: rows.map((r) => r.map((p) => p.text).join("")).join("\n") };
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const rows = await build($);
    return Box({
      flexDirection: "column",
      children: rows.map((parts) =>
        Box({ flexDirection: "row", children: parts.map((p) => Text({ color: p.color, dimColor: p.dim, bold: p.bold, wrap: "wrap", children: p.text })) }),
      ),
    });
  });
}

async function record($, change, agentId) {
  const { value: requests = [] } = await $.state.get(REQUESTS);
  const now = await $.clock.now();
  let by = "me";
  if (agentId) {
    const agent = (await $.agent.list()).find((a) => a.id === agentId);
    by = agent ? `subagent "${agent.name ?? agent.description}"` : "a subagent";
  }
  const list = requests.length ? requests : [{ ask: "(before your first message)", at: now, files: [], checks: [], commits: [] }];
  await $.state.set(REQUESTS, [...list.slice(0, -1), change(list[list.length - 1], now, by)]);
}

async function build($) {
  const { value: requests = [] } = await $.state.get(REQUESTS);
  const touched = requests.filter((r) => r.files.length || r.checks.length || r.commits.length);
  if (!touched.length) return [[{ text: "No changes yet this session.", dim: true }]];

  const allFiles = [...new Set(touched.flatMap((r) => r.files.map((f) => f.path)))];
  const dirty = await uncommitted($, allFiles);
  const lastWrite = new Map();
  for (const r of touched) for (const f of r.files) lastWrite.set(f.path, Math.max(lastWrite.get(f.path) ?? 0, f.at));
  const foreign = new Set();
  for (const [path, at] of lastWrite) {
    try {
      if ((await $.fs.stat(path)).mtimeMs > at + FOREIGN_MS) foreign.add(path);
    } catch {}
  }

  const rows = [];
  const hidden = touched.length - SHOWN;
  if (hidden > 0) rows.push([{ text: `(${hidden} earlier requests not shown)`, dim: true }]);
  for (const r of touched.slice(-SHOWN)) {
    rows.push([{ text: `▸ ${r.ask}`, bold: true }]);

    if (r.files.length) {
      const mine = r.files.filter((f) => f.by === "me");
      const theirs = r.files.filter((f) => f.by !== "me");
      rows.push([{ text: "   changed: ", dim: true }, { text: mine.map((f) => short(f.path)).join(", ") || "-" }]);
      for (const f of theirs) rows.push([{ text: `   by ${f.by}: `, dim: true }, { text: short(f.path) }]);
      const knobs = r.files.filter((f) => /\/knobs\/[^/]+\.ts$/.test(f.path));
      if (knobs.length) rows.push([{ text: `   knob registry edited: ${knobs.map((f) => short(f.path)).join(", ")}`, color: "cyan" }]);

      const lastEdit = Math.max(...r.files.map((f) => f.at));
      const after = r.checks.filter((c) => c.at >= lastEdit);
      const before = r.checks.filter((c) => c.at < lastEdit);
      if (!after.length) {
        rows.push([
          { text: "   NOT CHECKED since the last edit", color: "yellow", bold: true },
          ...(before.length ? [{ text: `  (earlier: ${before.map((c) => `${c.what} ${c.ok ? "✓" : "✗"}`).join(" ")})`, dim: true }] : []),
        ]);
      } else rows.push([{ text: "   checked: ", dim: true }, ...after.map((c) => ({ text: `${c.what} ${c.ok ? "✓" : "✗"}  `, color: c.ok ? "green" : "red" }))]);
    } else if (r.checks.length) {
      rows.push([{ text: "   checked: ", dim: true }, ...r.checks.map((c) => ({ text: `${c.what} ${c.ok ? "✓" : "✗"}  `, color: c.ok ? "green" : "red" }))]);
    }

    for (const c of r.commits) {
      const partial = /\bpartial\b/i.test(c.subject);
      rows.push([{ text: `   commit ${c.hash} `, dim: true }, { text: clip(c.subject, 70) }, ...(partial ? [{ text: "  PARTIAL", color: "yellow" }] : [])]);
    }

    const open = r.files.filter((f) => dirty.has(f.path)).map((f) => short(f.path));
    if (open.length) rows.push([{ text: `   not committed: ${[...new Set(open)].join(", ")}`, color: "yellow" }]);
    const clash = r.files.filter((f) => foreign.has(f.path)).map((f) => short(f.path));
    if (clash.length) rows.push([{ text: `   ⚠ changed since by someone else: ${[...new Set(clash)].join(", ")}`, color: "red" }]);
  }
  return rows;
}

async function uncommitted($, paths) {
  if (!paths.length) return new Set();
  try {
    const { stdout } = await $.process.run(["git", "status", "--porcelain", "--no-renames", "-z", "--", ...paths]);
    const top = (await $.process.run(["git", "rev-parse", "--show-toplevel"])).stdout.trim();
    return new Set(stdout.split("\0").filter(Boolean).map((l) => `${top}/${l.slice(3)}`));
  } catch {
    return new Set();
  }
}

function short(path) {
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : path;
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
