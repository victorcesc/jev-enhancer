#!/usr/bin/env node
// Regressão da política conservadora do Jev Verify.
//
//   TYPESAFE_AI_API_KEY=... node test/verify-policy.mjs
//
// Gasta ~4 chamadas ao Jev (centavos). Roda contra dados REAIS de execuções
// arquivadas em research/exp-abc/runs, não contra fixtures sintéticas.
//
// Os dois lados que importam, e que a política antiga não conseguia satisfazer
// ao mesmo tempo:
//
//   1. achado REAL nunca é removido — mesmo quando o Jev duvida dele.
//      Na política antiga, `valid < 0.15` apagava; b-1 e b-2 perderam assim
//      dois defeitos que eu verifiquei no código à mão.
//
//   2. achado FALSIFICÁVEL é removido — quando o próprio diff desmente a
//      premissa. Sem isto, tornar o verificador conservador seria só desligá-lo.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyFindings, keep } from "../src/verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(HERE, "../research/exp-abc/runs");
const REPO = "/Users/cesc/Projects/pdv-feat-baseline";

const diffOf = (run) => {
  const ctx = readFileSync(path.join(RUNS, run, "jev-dir/review-context.md"), "utf8");
  return /```diff\n([\s\S]*?)\n```/.exec(ctx)?.[1] ?? "";
};
const findingsOf = (run) =>
  JSON.parse(readFileSync(path.join(RUNS, run, "findings.json"), "utf8")).findings;

let falhas = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  ok  " : "  FALHOU  "} ${msg}`);
  if (!ok) falhas++;
};

// --- 1. achados reais sobrevivem -------------------------------------------
// b-1 e b-2 são as execuções onde a política antiga destruiu um defeito real
// cada. Se algum dia voltarem a encolher, esta regressão pega.
for (const run of ["b-1", "b-2"]) {
  const findings = findingsOf(run);
  const { findings: v, mode } = await verifyFindings(findings, REPO, diffOf(run));
  if (mode === "mock") {
    console.log(`\n${run}: sem chave do Jev — teste inconclusivo, pulando`);
    continue;
  }
  const kept = keep(v);
  console.log(`\n${run}: ${findings.length} -> ${kept.length} mantidos`);
  check(kept.length === findings.length,
        `nenhum achado real removido (esperado ${findings.length}, ficou ${kept.length})`);
  for (const f of v.filter((x) => x.verdict === "contradicted")) {
    console.log(`      removido: ${f.symbol} — ${f.reason}`);
  }
  check(v.every((f) => typeof f.reason === "string" && f.reason.length > 0),
        "todo veredito traz motivo registrado");
}

// --- 2. achados falsificáveis são removidos --------------------------------
// Premissas que o diff desmente diretamente: a rota ESTÁ registrada, e não
// existe loop de retry nenhum em ListPending.
const plantados = [
  {
    file: "packages/api-go/internal/middleware/routes.go",
    symbol: "bearerRoutePrefixes",
    severity: "high",
    issue:
      "A rota /api/v1/customers/ NAO foi adicionada a bearerRoutePrefixes em " +
      "internal/middleware/routes.go, entao toda requisicao ao endpoint de fiado " +
      "exige X-API-Key e falha com 401 para clientes que usam Bearer.",
  },
  {
    file: "packages/api-go/internal/fiado/pending.go",
    symbol: "ListPending",
    severity: "high",
    issue:
      "ListPending faz retry em loop com off-by-one no contador, causando uma " +
      "requisicao extra ao banco a cada chamada.",
  },
];
const { findings: pv, mode } = await verifyFindings(plantados, REPO, diffOf("b-1"));
if (mode === "mock") {
  console.log("\nplantados: sem chave do Jev — teste inconclusivo");
} else {
  console.log(`\nplantados: ${plantados.length} -> ${keep(pv).length} mantidos`);
  for (const f of pv) console.log(`      [${f.verdict}] ${f.symbol} — ${f.reason}`);
  check(keep(pv).length === 0, "achados falsificáveis foram removidos");
  check(pv.every((f) => f.verdict === "contradicted"),
        "removidos pelo veredito `contradicted`, não por dúvida");
}

console.log(falhas === 0 ? "\nTUDO OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
