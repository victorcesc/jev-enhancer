#!/usr/bin/env node
// Regressão da refutação determinística.
//
//   node test/claims-refutacao.mjs
//
// Não usa rede nem chave: é `grep` com regras. Roda contra TODOS os achados
// reais já coletados (research/*/runs/*/findings.json), que é o único jeito
// honesto de medir falsa refutação — a métrica que importa aqui.
//
// Dois lados:
//   1. a alucinação do Haiku ("assertAppError não está definida") é refutada;
//   2. NENHUM achado real é refutado.
//
// O (2) é o que pegou três versões erradas desta lógica:
//   - `não é <qualquer coisa>` como negação -> 49 de 50 refutados
//   - janela de ±70 chars fatiando texto -> `...UserIDAndIDParams` virava
//     `IDAndID`, que existia noutro arquivo
//   - campo `symbol` como sujeito da negação -> o símbolo existe, o ARQUIVO
//     citado é que não; refutava o defeito do sqlc em 7 execuções
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afirmaInexistencia, refutaInexistencia } from "../src/claims.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = "/Users/cesc/Projects/pdv-feat-baseline";
let falhas = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  ok  " : "  FALHOU  "} ${msg}`);
  if (!ok) falhas++;
};

// --- 1. a alucinação real do experimento E ---------------------------------
const halluc = {
  file: "packages/api-go/internal/fiado/page_test.go",
  symbol: "assertAppError",
  issue:
    "Funcao `assertAppError` nao esta definida em lugar nenhum do pacote, " +
    "entao os testes de internal/fiado nao compilam.",
};
const r = refutaInexistencia(halluc, REPO);
check(!!r, `alucinação refutada${r ? ` por ${r.file}:${r.line}` : ""}`);

// --- 2. nenhum achado real pode ser refutado -------------------------------
let total = 0;
let negacoes = 0;
const refutados = [];
for (const dir of ["exp-abc/runs", "exp-d/runs", "exp-e/runs"]) {
  const base = path.join(HERE, "../research", dir);
  if (!existsSync(base)) continue;
  for (const rel of globSync("*/findings.json", { cwd: base })) {
    const doc = JSON.parse(readFileSync(path.join(base, rel), "utf8"));
    for (const f of doc.findings ?? doc) {
      total++;
      if (!afirmaInexistencia(`${f.symbol ?? ""} ${f.issue ?? ""}`)) continue;
      negacoes++;
      const ref = refutaInexistencia(f, REPO);
      if (ref) refutados.push({ rel, symbol: f.symbol, prova: `${ref.symbol} @ ${ref.file}:${ref.line}` });
    }
  }
}
console.log(`\nachados analisados: ${total} | afirmam inexistência: ${negacoes}`);
for (const x of refutados) console.log(`  FALSA REFUTAÇÃO [${x.rel}] ${x.symbol} -> ${x.prova}`);
check(refutados.length === 0, `nenhum achado real refutado (${refutados.length} refutações falsas)`);

console.log(falhas === 0 ? "\nTUDO OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
