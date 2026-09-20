// prepare — interface machine-to-machine usada pelo adapter.
//
// Junta, sem LLM nenhuma: o diff, as regras do repo e a saída dos checks
// determinísticos do próprio projeto. Avalia o gate e, se passar, grava o
// contexto em .jev/review-context.md para o subagente consumir.
//
// Saída em stdout: JSON com a decisão. É lida por máquina, não por gente.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectDiff, defaultBase, evaluateGate } from "./gate.mjs";

const MAX_DIFF_CHARS = 120_000;

const readRules = (root, config) => {
  const names = Array.isArray(config?.rules) ? config.rules : [];
  const out = [];
  for (const name of names) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    try {
      out.push({ name, content: readFileSync(file, "utf8") });
    } catch {
      /* ilegível: ignora */
    }
  }
  return out;
};

/** Executa os checks determinísticos do projeto. Cada um deve imprimir JSON. */
const runDeterministic = (root, config) => {
  const cmds = config?.deterministic?.commands;
  if (!Array.isArray(cmds) || cmds.length === 0) return { findings: [], errors: [] };
  const findings = [];
  const errors = [];
  for (const cmd of cmds) {
    try {
      const r = spawnSync("sh", ["-c", cmd], {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status !== 0 && !r.stdout) {
        errors.push({ cmd, error: (r.stderr || "").slice(0, 200) });
        continue;
      }
      const m = /[[{][\s\S]*[\]}]/.exec(r.stdout ?? "");
      if (!m) continue;
      const parsed = JSON.parse(m[0]);
      const list = Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
      for (const f of list) findings.push({ ...f, source: cmd });
    } catch (e) {
      errors.push({ cmd, error: String(e.message ?? e).slice(0, 200) });
    }
  }
  return { findings, errors };
};

const renderContext = (diff, rules, detFindings) => {
  const parts = [
    "# Contexto de review (gerado pelo jev-enhancer)",
    "",
    "## Diff em revisão",
    "```diff",
    diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n[... cortado por tamanho ...]" : diff,
    "```",
  ];
  if (detFindings.length) {
    parts.push(
      "",
      "## Achados determinísticos (já verificados por ferramenta, não re-analise)",
      "```json",
      JSON.stringify(detFindings, null, 2),
      "```",
    );
  }
  for (const r of rules) {
    parts.push("", `## Invariantes do repositório — ${r.name}`, r.content);
  }
  return parts.join("\n");
};

export const prepare = (root, config, opts = {}) => {
  const base = opts.base ?? defaultBase(root);
  const { diff } = collectDiff(root, base);
  const gate = evaluateGate(root, config, diff);

  if (!gate.pass) {
    return { gate: "skipped", reason: gate.reason, stats: gate.stats, base: base ?? null };
  }

  const rules = readRules(root, config);
  const det = runDeterministic(root, config);
  const context = renderContext(diff, rules, det.findings);

  const dir = path.join(root, ".jev");
  mkdirSync(dir, { recursive: true });
  const contextFile = path.join(dir, "review-context.md");
  writeFileSync(contextFile, context);

  return {
    gate: "passed",
    reason: gate.reason,
    stats: gate.stats,
    base: base ?? null,
    context_file: contextFile,
    rules: rules.map((r) => r.name),
    deterministic_findings: det.findings.length,
    deterministic_errors: det.errors,
    passes: config?.review?.passes ?? ["correctness", "tests"],
  };
};
