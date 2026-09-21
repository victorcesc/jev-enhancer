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

/** Protocolo completo, executado DENTRO do subagente (contexto fresco). */
const subagentPrompt = (contextFile, config, detCount) => {
  const passes = config?.review?.passes ?? ["correctness", "tests"];
  const rel = path.basename(contextFile);
  return `Você é um revisor de código sênior. Execute o protocolo abaixo INTEIRO e
devolva APENAS o JSON final — sem preâmbulo, sem raciocínio, sem relatório.

Leia o contexto: \`.jev/${rel}\` (diff da mudança, invariantes do repositório${
    detCount ? `, e ${detCount} achado(s) já verificados por ferramenta determinística` : ""
  }).

## Passo 1 — análise de CORREÇÃO
Defeitos funcionais/lógicos introduzidos pelo diff: estado inconsistente,
caminhos de falha não tratados, corridas, donos duplicados de um mesmo estado,
recursos não liberados, violações dos invariantes do repositório. Priorize o
que quebra em produção e que os testes não pegariam.

## Passo 2 — análise de TESTES
Comportamento introduzido ou alterado sem cobertura; caminhos infelizes não
exercitados; testes que asseguram menos do que aparentam (campos declarados e
nunca comparados, asserções ausentes).

Faça as duas análises de forma independente antes de juntar — não deixe a
primeira contaminar a segunda.

## Passo 3 — consolidar
Junte os achados dos ${passes.length} passos, remova duplicatas e grave em
\`.jev/findings.json\`:
{"findings":[{"file":"...","line":0,"symbol":"...","issue":"...","kind":"bug|rule","severity":"high|med|low"}]}

## Passo 4 — triagem
Rode: \`JEV_VERIFY_CMD\`
Isso grava \`.jev/findings-verified.json\` com o veredito do Jev por achado.

## Passo 5 — resposta
Responda SOMENTE com o JSON compacto abaixo, lendo de findings-verified.json.
Inclua no máximo 10 achados, ordenados por severidade. Campo \`summary\` com no
máximo 140 caracteres. NÃO inclua o raciocínio nem o relatório completo — eles
ficam nos arquivos.

{"status":"reviewed","counts":{"total":0,"confirmed":0,"needs_context":0,"rejected":0},
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
      `${opts.jevCommand ?? "jev"} verify .jev/findings.json`,
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
