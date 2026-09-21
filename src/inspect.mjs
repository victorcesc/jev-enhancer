// inspect — autópsia de uma execução.
//
// Responde as perguntas que decidem se o desenho funciona:
//   1. o hook disparou? em que passo parou? (trace)
//   2. o agente obedeceu o protocolo? (transcript: Task, jev verify)
//   3. o custo do review ficou contido? (turnos/tokens antes vs depois do bloqueio)
//   4. respeitou o read-only? (diff congelado vs diff final)
//
// A pergunta 3 é a que importa: se os passes rodarem no contexto principal em
// vez de subagentes, o custo explode — e é exatamente isso que o desenho
// tenta evitar.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const readJsonl = (file) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
};

const findTranscript = (sessionId) => {
  const base = path.join(os.homedir(), ".claude", "projects");
  if (!existsSync(base)) return null;
  for (const proj of readdirSync(base)) {
    const f = path.join(base, proj, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
};

const TOKEN_KEYS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
const sumTokens = (u) => (u ? TOKEN_KEYS.reduce((s, k) => s + (u[k] ?? 0), 0) : 0);

/**
 * Percorre o transcript separando o que veio ANTES e DEPOIS do bloqueio.
 * O bloqueio é identificado pela instrução que o hook injeta.
 */
const analyzeTranscript = (file) => {
  const lines = readJsonl(file);
  const out = {
    turns_before: 0, turns_after: 0,
    tokens_before: 0, tokens_after: 0,
    cache_read_after: 0, output_after: 0,
    tools_before: {}, tools_after: {},
    block_found: false, block_index: null,
    subagents: 0, jev_verify_calls: 0,
  };
  // O transcript registra a MESMA mensagem mais de uma vez (streaming +
  // final). Somar todas dobra os números — foi o que aconteceu no primeiro
  // relatório. Contamos cada id de mensagem uma única vez.
  const counted = new Set();
  let after = false;
  lines.forEach((e, i) => {
    // json.dumps escapa acentos; comparar no objeto bruto evita o falso negativo
    const text = JSON.stringify(e, null, 0);
    if (!after && (text.includes("jev-enhancer") && text.includes("Review"))) {
      after = true;
      out.block_found = true;
      out.block_index = i;
    }
    const msg = e.message;
    if (!msg || typeof msg !== "object") return;
    const bucketTurns = after ? "turns_after" : "turns_before";
    const bucketTokens = after ? "tokens_after" : "tokens_before";
    const bucketTools = after ? "tools_after" : "tools_before";
    // dedup: mensagem já contabilizada não soma turno, token nem ferramenta
    const id = msg.id ?? `${e.uuid ?? i}`;
    if (counted.has(id)) return;
    counted.add(id);

    if (msg.role === "assistant") {
      out[bucketTurns] += 1;
      if (msg.usage) {
        out[bucketTokens] += sumTokens(msg.usage);
        if (after) {
          out.cache_read_after += msg.usage.cache_read_input_tokens ?? 0;
          out.output_after += msg.usage.output_tokens ?? 0;
        }
      }
    }
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (c?.type !== "tool_use") continue;
      const name = c.name ?? "?";
      out[bucketTools][name] = (out[bucketTools][name] ?? 0) + 1;
      // O nome da ferramenta de subagente varia entre versões do harness
      // (Task/Agent). Medir o nome errado faz o relatório acusar "0 subagentes"
      // quando eles foram usados — foi o que aconteceu no primeiro teste real.
      if (name === "Task" || name === "Agent") out.subagents += 1;
      // O verify pode ser invocado como `jev verify` (instalado) ou
      // `node .../cli.mjs verify` (instalação local, sem PATH).
      if (name === "Bash" && /(jev|cli\.mjs)\s+verify/.test(JSON.stringify(c.input ?? {})))
        out.jev_verify_calls += 1;
    }
  });
  return out;
};

/** Diff congelado no bloqueio vs diff atual: detecta violação do read-only. */
const readOnlyCheck = (root) => {
  const ctx = path.join(root, ".jev", "review-context.md");
  if (!existsSync(ctx)) return { checked: false, reason: "sem review-context.md" };
  const frozen = readFileSync(ctx, "utf8");
  const m = /```diff\n([\s\S]*?)\n```/.exec(frozen);
  if (!m) return { checked: false, reason: "diff não encontrado no contexto" };
  const r = spawnSync("git", ["diff", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  const current = r.status === 0 ? r.stdout : "";
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const same = norm(m[1]).startsWith(norm(current).slice(0, 400)) || norm(current).startsWith(norm(m[1]).slice(0, 400));
  return { checked: true, unchanged: same };
};

export const inspectRun = (root, sessionId) => {
  const report = { session: sessionId ?? null };

  // 1. trace: onde parou
  const traceEntries = readJsonl(path.join(root, ".jev", "trace.jsonl"));
  report.trace = traceEntries;
  report.last_step = traceEntries.length ? traceEntries[traceEntries.length - 1].step : null;

  // 2. runs: desfechos
  const runs = readJsonl(path.join(root, ".jev", "runs.jsonl"));
  report.runs = runs.length;
  report.outcomes = runs.reduce((acc, r) => {
    const k = `${r.status}${r.reason ? `/${r.reason}` : ""}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  // 3. artefatos do protocolo
  const jevDir = path.join(root, ".jev");
  report.artifacts = {
    review_context: existsSync(path.join(jevDir, "review-context.md")),
    findings: existsSync(path.join(jevDir, "findings.json")),
    findings_verified: existsSync(path.join(jevDir, "findings-verified.json")),
  };

  // 4. transcript
  const sid = sessionId ?? runs.findLast?.((r) => r.session)?.session ?? null;
  const tfile = sid ? findTranscript(sid) : null;
  report.transcript = tfile ? analyzeTranscript(tfile) : null;
  report.transcript_file = tfile;

  // 5. read-only
  report.read_only = readOnlyCheck(root);

  return report;
};

export const renderInspect = (report) => {
  const L = [];
  L.push("=== 1. o hook disparou? (trace por invocação) ===");
  if (report.trace.length === 0) {
    L.push("  NENHUM trace. Ou JEV_DEBUG não estava ligado, ou o hook nunca rodou.");
  } else {
    // o trace acumula entre invocações; cada uma começa no passo "hook"
    const invocations = [];
    for (const e of report.trace) {
      if (e.step === "hook" || invocations.length === 0) invocations.push([]);
      invocations[invocations.length - 1].push(e);
    }
    invocations.forEach((inv, i) => {
      const last = inv[inv.length - 1];
      L.push(`  --- invocação ${i + 1} → parou em "${last.step}" ---`);
      for (const e of inv) {
        const extra = Object.entries(e)
          .filter(([k]) => !["at", "step", "ms_since_start"].includes(k))
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
          .join(" ");
        L.push(`    ${String(e.ms_since_start).padStart(5)}ms ${e.step.padEnd(9)} ${extra}`);
      }
    });
    const blocked = invocations.filter((inv) => inv.some((e) => e.step === "block")).length;
    L.push(`  invocações: ${invocations.length} · bloqueios emitidos: ${blocked}${blocked > 1 ? "  ← ALERTA: mais de um bloqueio indica loop" : ""}`);
  }

  L.push("", "=== 2. desfechos registrados ===");
  L.push(`  execuções: ${report.runs} → ${JSON.stringify(report.outcomes)}`);

  L.push("", "=== 3. o agente obedeceu o protocolo? ===");
  const a = report.artifacts;
  L.push(`  contexto preparado:     ${a.review_context ? "sim" : "NÃO"}`);
  L.push(`  findings.json gravado:  ${a.findings ? "sim" : "NÃO"}`);
  L.push(`  verify executado:       ${a.findings_verified ? "sim" : "NÃO"}`);

  const t = report.transcript;
  if (!t) {
    L.push("  (transcript não encontrado — não dá para conferir subagentes)");
  } else {
    L.push(`  bloqueio localizado:    ${t.block_found ? `sim (entrada ${t.block_index})` : "NÃO"}`);
    L.push(`  SUBAGENTES usados:      ${t.subagents} ${t.subagents === 0 ? "← ALERTA: passes rodaram no contexto principal" : ""}`);
    L.push(`  chamadas a jev verify:  ${t.jev_verify_calls}`);

    L.push("", "=== 4. o custo do review ficou contido? ===");
    L.push(`  implementação: ${t.turns_before} turnos, ${t.tokens_before.toLocaleString()} tokens`);
    L.push(`  review:        ${t.turns_after} turnos, ${t.tokens_after.toLocaleString()} tokens`);
    const pct = t.tokens_before > 0 ? ((t.tokens_after / t.tokens_before) * 100).toFixed(1) : "?";
    L.push(`  custo marginal do review: ${pct}% da implementação`);
    L.push(`  ferramentas no review: ${JSON.stringify(t.tools_after)}`);

    // A anatomia importa mais que o total: quase tudo é contexto re-cobrado a
    // cada turno, não trabalho. Reduzir TURNOS vale mais que reduzir análise.
    if (t.turns_after > 0) {
      const share = t.tokens_after > 0 ? ((t.cache_read_after / t.tokens_after) * 100).toFixed(1) : "0";
      const perTurn = Math.round(t.cache_read_after / t.turns_after);
      L.push(`  → contexto re-cobrado: ${t.cache_read_after.toLocaleString()} (${share}%) · trabalho real (output): ${t.output_after.toLocaleString()}`);
      L.push(`  → ${t.turns_after} turnos × ${perTurn.toLocaleString()} de contexto; com 2 turnos seria ${(2 * perTurn).toLocaleString()}`);
    }
  }

  L.push("", "=== 5. respeitou o read-only? ===");
  const ro = report.read_only;
  if (!ro.checked) L.push(`  não verificável: ${ro.reason}`);
  else L.push(`  código inalterado após o bloqueio: ${ro.unchanged ? "sim" : "NÃO — o agente mexeu no código"}`);

  return L.join("\n");
};
