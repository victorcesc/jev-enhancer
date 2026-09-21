#!/usr/bin/env node
// Adapter Claude Code — hook de Stop, versão LEGADA (arquitetura antiga).
//
// Preservado só para o braço d2 do experimento D: é o Stop que bloqueia com a
// instrução COMPLETA do review, que era o gatilho principal antes do roteiro
// pós-ABC. Não é o hook do produto — esse virou fallback.
//
// Imports ajustados para a profundidade daqui (research/exp-d/hooks).
//
// FAIL-OPEN é a regra número um: este processo roda dentro da sessão de
// alguém. Chave ausente, git lento, config quebrada, bug nosso — todo caminho
// termina em exit 0 silencioso. Um review perdido custa um achado; um hook
// que trava custa a sessão inteira.
//
// Fluxo (ver README):
//   session guard → cost gate → bloqueia UMA vez com instrução → agente
//   roda os passes em SUBAGENTE → apresenta → para de novo → guard silencia.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, findRepoRoot } from "../../../src/config.mjs";
import { gitRoot } from "../../../src/gate.mjs";
import { prepare } from "../../../src/prepare.mjs";
import { claimRun, markReviewed } from "../../../src/session.mjs";
import { record } from "../../../src/log.mjs";
import { trace } from "../../../src/trace.mjs";

const BUDGET_MS = 60_000; // teto do hook inteiro
const watchdog = setTimeout(() => process.exit(0), BUDGET_MS);

const silent = () => {
  clearTimeout(watchdog);
  process.exit(0);
};

const block = (reason) => {
  clearTimeout(watchdog);
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
};

const readStdin = () =>
  new Promise((resolve) => {
    const chunks = [];
    const t = setTimeout(() => resolve(Buffer.concat(chunks).toString()), 3_000);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(t);
      resolve(Buffer.concat(chunks).toString());
    });
  });

/**
 * Como o agente deve invocar o CLI. Se `jev` não estiver no PATH (instalação
 * local, sem npm link), emitimos o caminho absoluto — senão a instrução manda
 * rodar um comando que não existe e o protocolo quebra no passo do verify.
 */
const jevCommand = () => {
  const onPath = spawnSync("sh", ["-c", "command -v jev"], { encoding: "utf8", timeout: 5000 });
  if (onPath.status === 0 && (onPath.stdout ?? "").trim()) return "jev";
  const here = path.dirname(new URL(import.meta.url).pathname);
  return `node ${path.resolve(here, "../../src/cli.mjs")}`;
};

/**
 * Instrução MÍNIMA: uma ida e uma volta.
 *
 * Medido: 98,3% do custo do review era contexto re-cobrado a cada turno de
 * orquestração do agente principal (9 turnos × 134k). O trabalho de análise
 * em si custava 5.944 tokens. Por isso o protocolo inteiro foi movido para
 * DENTRO do subagente — onde o contexto é fresco e barato — e a sessão
 * principal faz apenas: chamar (1 turno) e apresentar (1 turno).
 */
const instruction = (prep) => {
  const promptRel = path.relative(process.cwd(), prep.prompt_file);
  return `Review automático do jev-enhancer.

Lance **UM ÚNICO subagente** com contexto limpo e passe a ele, como prompt, o
conteúdo de \`${promptRel}\`. Esse arquivo contém o protocolo completo (as duas
análises, a consolidação e a triagem) — o subagente executa tudo sozinho e
devolve um JSON compacto.

Quando ele responder: **apresente os achados ao usuário** no seu resumo final,
ordenados por severidade.

Duas regras:
- NÃO orquestre etapa por etapa nesta sessão. Cada turno seu aqui re-lê todo o
  contexto acumulado e custa caro; o subagente faz o trabalho barato.
- NÃO corrija nada. Este review é somente leitura — quem decide o que mudar é o
  usuário. Se algum achado parecer falso positivo, diga isso em vez de omiti-lo.`;
};

const main = async () => {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    silent();
  }
  const cwd = input.cwd ?? process.cwd();
  const root = gitRoot(cwd) ?? findRepoRoot(cwd);
  trace(root, "hook", { session: input.session_id ?? null, cwd });

  // 1. session guard — antes de qualquer trabalho
  const claim = claimRun(input.session_id);
  trace(root, "guard", { proceed: claim.proceed, reason: claim.reason, executions: claim.state.executions });
  if (!claim.proceed) {
    record(root, { status: "skipped", reason: claim.reason, session: input.session_id });
    silent();
  }

  // 2. config: sem config, a ferramenta não age neste repo
  const config = loadConfig(root);
  trace(root, "config", { found: !!config, rules: config?.rules ?? null });
  if (!config) {
    record(root, { status: "skipped", reason: "no_config", session: input.session_id });
    silent();
  }

  // 3. cost gate + preparação
  let prep;
  try {
    prep = prepare(root, config, { jevCommand: jevCommand() });
  } catch (e) {
    trace(root, "prepare", { error: String(e.message ?? e).slice(0, 200) });
    record(root, { status: "failed", error: String(e.message ?? e).slice(0, 300), session: input.session_id });
    silent(); // fail-open
  }
  trace(root, "gate", { result: prep.gate, reason: prep.reason, ...prep.stats });

  if (prep.gate !== "passed") {
    record(root, {
      status: "skipped",
      gate: prep.gate,
      reason: prep.reason,
      stats: prep.stats,
      session: input.session_id,
    });
    silent();
  }

  // 4. marca ANTES de bloquear: se o agente parar de novo, o guard silencia
  markReviewed(input.session_id);
  trace(root, "prepare", {
    context_file: prep.context_file,
    deterministic_findings: prep.deterministic_findings,
    passes: prep.passes,
  });
  record(root, {
    status: "completed",
    gate: prep.gate,
    reason: prep.reason,
    stats: prep.stats,
    rules: prep.rules,
    deterministic_findings: prep.deterministic_findings,
    passes: prep.passes,
    session: input.session_id,
  });

  const reason = instruction(prep);
  trace(root, "block", { chars: reason.length });
  block(reason);
};

main().catch(() => silent());
