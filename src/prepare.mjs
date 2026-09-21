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

/**
 * Protocolo do subagente — escrito para MINIMIZAR TURNOS.
 *
 * A versão anterior enumerava 5 passos e o subagente gastou 24 turnos: 19
 * deles produzindo 3-8 tokens cada, enquanto reliam ~71k de contexto. Pedir
 * orquestração produz orquestração.
 *
 * Esta versão descreve o RESULTADO esperado e a sequência exata de 3 ações,
 * em vez de etapas de raciocínio. As duas análises continuam existindo como
 * exigência do conteúdo, não como passos separados no tempo.
 */
// Teto de achados reportados. Era 10 por arbitrariedade; nas duas primeiras
// medições os dois braços pararam exatamente em 10, o que torna impossível
// distinguir "achou 10" de "foi cortado em 10". 20 dá folga para o teto não
// ser o que determina o resultado.
const DEFAULT_MAX_FINDINGS = 20;

const subagentPrompt = (contextFile, config, detCount) => {
  const rel = path.basename(contextFile);
  const maxFindings = config?.review?.max_findings ?? DEFAULT_MAX_FINDINGS;
  return `Revisor de código sênior. Execute exatamente três ações, sem etapas
intermediárias e sem narrar o que vai fazer. Cada turno seu relê todo o
contexto acumulado e custa caro — trabalhe em silêncio e entregue.

AÇÃO 1 — Leia \`.jev/${rel}\` (diff, invariantes do repositório${
    detCount ? `, ${detCount} achado(s) já verificados por ferramenta` : ""
  }).

AÇÃO 2 — Analise e envie os achados direto para a triagem, num único comando:

  echo '{"findings":[...]}' | JEV_VERIFY_CMD

Cada achado: {"file","line","symbol","issue","kind":"bug|rule","severity":"high|med|low"}

Cubra DOIS eixos na mesma análise, sem deixar um contaminar o outro:
• correção — defeitos funcionais/lógicos do diff: estado inconsistente, caminhos
  de falha não tratados, corridas, donos duplicados de um mesmo estado, recursos
  não liberados, violações dos invariantes do repositório. Priorize o que quebra
  em produção e passa nos testes.
• testes — comportamento novo ou alterado sem cobertura, caminhos infelizes não
  exercitados, testes que asseguram menos do que aparentam (campos declarados e
  nunca comparados, asserções ausentes).

AÇÃO 3 — Responda SOMENTE o JSON abaixo, preenchido com a saída da triagem.
Máximo ${maxFindings} achados, ordenados por severidade; \`summary\` até 140 caracteres.
Sem preâmbulo, sem raciocínio, sem relatório — esses ficam nos arquivos.

{"status":"reviewed","counts":{"total":0,"confirmed":0,"needs_context":0,"contradicted":0},
 "findings":[{"file":"...","line":0,"severity":"high","summary":"..."}]}`;
};

export const prepare = (root, config, opts = {}) => {
  const base = opts.base ?? defaultBase(root);
  // ignore_paths vale também para os arquivos novos: sem isso, .jev/ e .claude/
  // entram no diff como ruído e competem com o código pelo contexto.
  const ignore = Array.isArray(config?.gate?.ignore_paths) ? config.gate.ignore_paths : [];
  const { diff } = collectDiff(root, base, [...ignore, ".jev/", ".claude/"]);
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

  // O protocolo inteiro vai para um arquivo que o SUBAGENTE lê. Assim a
  // mensagem injetada na sessão principal fica mínima e, principalmente, o
  // agente principal gasta 2 turnos (chamar + receber) em vez de orquestrar
  // etapa por etapa — 98% do custo do review era contexto re-cobrado a cada
  // turno de orquestração.
  const promptFile = path.join(dir, "review-prompt.md");
  writeFileSync(
    promptFile,
    subagentPrompt(contextFile, config, det.findings.length).replace(
      "JEV_VERIFY_CMD",
      `${opts.jevCommand ?? "jev"} verify -`,
    ),
  );

  return {
    gate: "passed",
    reason: gate.reason,
    stats: gate.stats,
    base: base ?? null,
    context_file: contextFile,
    prompt_file: promptFile,
    rules: rules.map((r) => r.name),
    deterministic_findings: det.findings.length,
    deterministic_errors: det.errors,
    passes: config?.review?.passes ?? ["correctness", "tests"],
  };
};
