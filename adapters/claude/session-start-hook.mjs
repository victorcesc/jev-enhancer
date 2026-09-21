#!/usr/bin/env node
// Adapter Claude Code — hook de SessionStart.
//
// Instala o contrato: o agente aprende, ANTES de começar, que `jev review`
// faz parte da Definition of Done. É o gatilho principal desde o roteiro
// pós-experimento A/B/C; o Stop hook virou apenas fallback.
//
// O que NÃO vai aqui: o protocolo da análise. O agente principal só precisa
// saber que o review é obrigatório e como disparar — cada caractere injetado
// no contexto principal é re-cobrado a cada turno da sessão. O protocolo
// completo vive em .jev/review-prompt.md e é lido pelo subagente.
//
// FAIL-OPEN: sem config, sem repo, qualquer erro — exit 0 em silêncio. Não
// injetar o contrato custa um review; travar custa a sessão.
import { loadConfig, findRepoRoot } from "../../src/config.mjs";
import { gitRoot } from "../../src/gate.mjs";
import { jevCommand, doneContract } from "../../src/contract.mjs";
import { trace } from "../../src/trace.mjs";

const silent = () => process.exit(0);

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

  // Sem config, este repo não usa a ferramenta: não poluir o contexto.
  if (!loadConfig(root)) silent();

  const context = doneContract(jevCommand());
  trace(root, "session_start", { session: input.session_id ?? null, chars: context.length });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    }),
  );
  process.exit(0);
};

main().catch(() => silent());
