#!/usr/bin/env node
// Adapter Claude Code — hook de Stop, agora só FALLBACK.
//
// O gatilho principal passou a ser o contrato instalado no início da sessão
// (session-start-hook.mjs): o agente sabe que `jev review` faz parte da
// Definition of Done e chama sozinho, antes de tentar finalizar.
//
// Por que mudou: no experimento A/B/C, a MESMA instrução de review rendeu 41%
// de recall entregue como prompt do usuário e 32% entregue como bloqueio de
// Stop. O agente trata o bloqueio como interrupção a despachar, não como a
// tarefa. Este hook existe agora só para o caso de o agente esquecer.
//
// FAIL-OPEN continua sendo a regra número um: este processo roda dentro da
// sessão de alguém. Chave ausente, git lento, config quebrada, bug nosso —
// todo caminho termina em exit 0 silencioso.
import { loadConfig, findRepoRoot } from "../../src/config.mjs";
import { collectDiff, defaultBase, evaluateGate, gitRoot } from "../../src/gate.mjs";
import { claimRun, markReviewed } from "../../src/session.mjs";
import { jevCommand, fallbackBlock } from "../../src/contract.mjs";
import { record } from "../../src/log.mjs";
import { trace } from "../../src/trace.mjs";

const BUDGET_MS = 60_000;
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

const main = async () => {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    silent();
  }
  const cwd = input.cwd ?? process.cwd();
  const root = gitRoot(cwd) ?? findRepoRoot(cwd);
  trace(root, "hook", { session: input.session_id ?? null, cwd, mode: "fallback" });

  // 1. O caminho FELIZ agora é sair daqui: `jev verify` marcou a sessão como
  //    revisada quando o agente rodou o review por conta própria.
  const claim = claimRun(input.session_id);
  trace(root, "guard", { proceed: claim.proceed, reason: claim.reason, executions: claim.state.executions });
  if (!claim.proceed) {
    record(root, { status: "skipped", reason: claim.reason, session: input.session_id, stage: "fallback" });
    silent();
  }

  // 2. sem config, a ferramenta não age neste repo
  const config = loadConfig(root);
  if (!config) {
    record(root, { status: "skipped", reason: "no_config", session: input.session_id });
    silent();
  }

  // 3. Gate só: nada de `prepare` aqui. Quem prepara é o `jev review` que o
  //    agente vai rodar em seguida — fazer as duas coisas duplicaria o
  //    trabalho e gravaria contexto que talvez nem seja usado.
  let gate;
  try {
    const ignore = Array.isArray(config?.gate?.ignore_paths) ? config.gate.ignore_paths : [];
    const { diff } = collectDiff(root, defaultBase(root), [...ignore, ".jev/", ".claude/"]);
    gate = evaluateGate(root, config, diff);
  } catch (e) {
    trace(root, "gate", { error: String(e.message ?? e).slice(0, 200) });
    silent(); // fail-open
  }
  trace(root, "gate", { pass: gate.pass, reason: gate.reason, ...gate.stats });

  if (!gate.pass) {
    record(root, { status: "skipped", gate: "skipped", reason: gate.reason, stats: gate.stats, session: input.session_id });
    silent();
  }

  // 4. marca ANTES de bloquear: se o agente parar de novo sem revisar, o guard
  //    silencia em vez de bloquear para sempre.
  markReviewed(input.session_id);
  record(root, {
    status: "completed", stage: "fallback", gate: "passed",
    reason: gate.reason, stats: gate.stats, session: input.session_id,
  });

  const reason = fallbackBlock(jevCommand());
  trace(root, "block", { chars: reason.length, mode: "fallback" });
  block(reason);
};

main().catch(() => silent());
