#!/usr/bin/env node
// jev — CLI do jev-enhancer.
//
// Comandos de usuário:  init, apply, status
// Comandos internos (machine-to-machine, usados pelo adapter): prepare, verify
//
// Princípio: chaves só por ambiente ou .env, nunca por argumento — argumento
// vaza em histórico de shell e em log de CI.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot, loadConfig, writeDefaultConfig } from "./config.mjs";
import { gitRoot } from "./gate.mjs";
import { prepare } from "./prepare.mjs";
import { verifyFindings, keep } from "./verify.mjs";
import { renderStatus } from "./status.mjs";
import { inspectRun, renderInspect } from "./inspect.mjs";
import { record } from "./log.mjs";

const [, , cmd, ...args] = process.argv;
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : undefined;
};
const root = gitRoot(process.cwd()) ?? findRepoRoot();

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

const cmdInit = () => {
  const { created, file } = writeDefaultConfig(root);
  console.log(created ? `criado ${path.relative(root, file)}` : `${path.relative(root, file)} já existe (mantido)`);
  console.log("");
  console.log("Revise o arquivo — em especial:");
  console.log("  rules:              os arquivos de instrução do seu repo");
  console.log("  gate.min_diff_lines: a partir de quantas linhas vale revisar");
  console.log("  deterministic.commands: seus checks próprios que emitem JSON");
  console.log("");
  console.log("Depois: jev apply claude");
};

const cmdApply = async () => {
  const harness = args[0];
  if (harness !== "claude") {
    die(`harness não suportado: ${harness ?? "(nenhum)"}\nno MVP só existe: jev apply claude`);
  }
  const scope = flag("project") ? "project" : "user";
  const { install, selfTest, pingJev } = await import("../adapters/claude/install.mjs");

  let installed;
  try {
    installed = install(scope, root);
  } catch (e) {
    die(`falha ao instalar: ${e.message}`);
  }
  console.log(`hook de Stop registrado em ${installed.file}${installed.replaced ? " (entrada anterior substituída)" : ""}`);

  // self-test: estrutural invalida; externo é diagnóstico
  const { structural, external } = selfTest(scope, root);
  if (structural.length > 0) {
    console.error("\nINSTALAÇÃO INVÁLIDA (erro estrutural):");
    for (const s of structural) console.error(`  - ${s}`);
    process.exit(1);
  }
  console.log("self-test estrutural: ok");

  const ping = await pingJev(root);
  if (!ping.ok) {
    console.warn("\nDiagnóstico (não impede o uso):");
    console.warn(`  - Jev indisponível agora: ${ping.reason}`);
    console.warn("    A instalação está correta. A triagem volta a funcionar quando a");
    console.warn("    dependência voltar / a chave for configurada (TYPESAFE_AI_API_KEY).");
  } else {
    console.log("self-test externo: Jev respondeu");
  }
  for (const e of external) console.warn(`  - ${e}`);

  if (!loadConfig(root)) {
    console.warn("\nAtenção: este repositório não tem .jev/config.yaml — rode `jev init`.");
    console.warn("Sem config, o adapter sai em silêncio e nada é revisado.");
  }
  console.log("\nPronto. Use o agente normalmente; o review entra sozinho antes da conclusão.");
};

const cmdPrepare = () => {
  const config = loadConfig(root);
  if (!config) {
    console.log(JSON.stringify({ gate: "skipped", reason: "no_config" }));
    return;
  }
  const base = flag("base");
  const out = prepare(root, config, typeof base === "string" ? { base } : {});
  console.log(JSON.stringify(out, null, 2));
};

const cmdVerify = async () => {
  const file = args.find((a) => !a.startsWith("--")) ?? ".jev/findings.json";
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  let findings = [];
  try {
    const parsed = JSON.parse(readFileSync(full, "utf8"));
    findings = Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
  } catch (e) {
    die(`não consegui ler os achados em ${file}: ${e.message}`);
  }
  // o diff congelado no bloqueio é a evidência que o Jev usa para julgar
  let diff = "";
  try {
    const ctx = readFileSync(path.join(root, ".jev", "review-context.md"), "utf8");
    diff = /```diff\n([\s\S]*?)\n```/.exec(ctx)?.[1] ?? "";
  } catch {
    /* sem contexto: o Jev julga só pelo texto do achado */
  }

  const t0 = Date.now();
  const { findings: verified, mode, usage } = await verifyFindings(findings, root, diff);
  const ms = Date.now() - t0;
  const kept = keep(verified);
  const counts = verified.reduce((a, f) => ({ ...a, [f.verdict]: (a[f.verdict] ?? 0) + 1 }), {});
  const outFile = path.join(root, ".jev", "findings-verified.json");
  writeFileSync(outFile, JSON.stringify({ mode, verdicts: counts, findings: kept }, null, 2));
  record(root, {
    status: "completed", stage: "verify", mode,
    findings: findings.length, verified: kept.length,
    verdicts: counts, jev_tokens: usage?.input_tokens ?? 0, ms,
  });
  console.log(JSON.stringify({
    mode, total: findings.length, kept: kept.length, verdicts: counts,
    jev_tokens: usage?.input_tokens ?? 0, ms, output: path.relative(root, outFile),
  }, null, 2));
};

const cmdStatus = () => console.log(renderStatus(root));

const cmdInspect = () => {
  const session = args.find((a) => !a.startsWith("--"));
  console.log(renderInspect(inspectRun(root, session)));
};

const HELP = `jev — code review agent-driven (jev-enhancer)

  jev init              cria .jev/config.yaml neste repositório
  jev apply claude      instala o adapter no Claude Code (+ self-test)
  jev status            mostra a última execução (never_run/skipped/completed/failed)
  jev inspect [sessão]  autópsia: onde parou, se o protocolo foi seguido,
                        custo do review e se o read-only foi respeitado
                        (rode com JEV_DEBUG=1 para ter o trace completo)

internos (usados pelo adapter):
  jev prepare [--base <ref>]     gate + preparação de contexto (JSON)
  jev verify [findings.json]     triagem dos achados (JSON)

Chaves: só via ambiente ou .env (TYPESAFE_AI_API_KEY). Nunca por argumento.`;

const main = async () => {
  switch (cmd) {
    case "init": return cmdInit();
    case "apply": return cmdApply();
    case "prepare": return cmdPrepare();
    case "verify": return cmdVerify();
    case "status": return cmdStatus();
    case "inspect": return cmdInspect();
    default: console.log(HELP);
  }
};

main().catch((e) => die(`erro: ${e.message}`));
