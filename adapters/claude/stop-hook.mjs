#!/usr/bin/env node
// Adapter Claude Code — hook de Stop.
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
import { loadConfig, findRepoRoot } from "../../src/config.mjs";
import { gitRoot } from "../../src/gate.mjs";
import { prepare } from "../../src/prepare.mjs";
import { claimRun, markReviewed } from "../../src/session.mjs";
import { record } from "../../src/log.mjs";

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

const instruction = (prep) => {
  const passes = prep.passes.join(" e ");
  return `Review automático do jev-enhancer.

O contexto já está preparado em \`${path.relative(process.cwd(), prep.context_file)}\`
(diff, invariantes do repositório${prep.deterministic_findings ? `, e ${prep.deterministic_findings} achado(s) determinístico(s) já verificados por ferramenta` : ""}).

Faça agora, antes de encerrar:

1. Rode ${prep.passes.length} análises INDEPENDENTES, cada uma em um SUBAGENTE com contexto
   limpo (não reaproveite o contexto desta sessão — ele é grande e caro):
   - **correctness**: defeitos funcionais/lógicos introduzidos pelo diff — estado
     inconsistente, caminhos de falha não tratados, corridas, donos duplicados de
     um mesmo estado, recursos não liberados, violações dos invariantes do repo.
   - **tests**: comportamento introduzido ou alterado sem cobertura adequada,
     caminhos infelizes não exercitados, testes que asseguram menos do que aparentam.
   Cada subagente lê o arquivo de contexto e responde SOMENTE com:
   {"findings":[{"file":"...","symbol":"...","issue":"...","kind":"bug|rule","severity":"high|med|low"}]}

2. Junte os achados dos ${passes}, remova duplicatas, grave em \`.jev/findings.json\`
   no formato {"findings":[...]} e rode: \`jev verify .jev/findings.json\`

3. APRESENTE o resultado ao usuário no seu resumo final, ordenado por severidade.

NÃO corrija nada agora. Este review é somente leitura — a decisão do que mudar é
do usuário. Se algum achado for claramente um falso positivo, diga isso em vez de
silenciá-lo.`;
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

  // 1. session guard — antes de qualquer trabalho
  const claim = claimRun(input.session_id);
  if (!claim.proceed) {
    record(root, { status: "skipped", reason: claim.reason, session: input.session_id });
    silent();
  }

  // 2. config: sem config, a ferramenta não age neste repo
  const config = loadConfig(root);
  if (!config) {
    record(root, { status: "skipped", reason: "no_config", session: input.session_id });
    silent();
  }

  // 3. cost gate + preparação
  let prep;
  try {
    prep = prepare(root, config);
  } catch (e) {
    record(root, { status: "failed", error: String(e.message ?? e).slice(0, 300), session: input.session_id });
    silent(); // fail-open
  }

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

  block(instruction(prep));
};

main().catch(() => silent());
