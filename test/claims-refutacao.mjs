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

// Achados COLETADOS que são comprovadamente falsos — eu verifiquei os dois no
// código. A premissa inicial deste teste ("tudo que foi coletado é real") caiu
// quando o Haiku 4.5 passou a rodar: modelo fraco com investigação rasa
// alucina, e o que ele produz fica nos mesmos arquivos que os achados bons.
// Estes DEVEM ser refutados; contá-los como falha esconderia o acerto.
const ALUCINACOES = new Map([
  ["stubUserLookup", "auth_router_test.go:38 define o tipo"],
  ["assertAppError", "pending_test.go:234 define a função"],
]);
const ehAlucinacao = (f) =>
  [...ALUCINACOES.keys()].some((s) => `${f.symbol ?? ""} ${f.issue ?? ""}`.includes(s)) &&
  /not\s+defined|n[aã]o\s+est[aá]\s+definid|not\s+declared/i.test(f.issue ?? "");

// --- 2. nenhum achado real pode ser refutado -------------------------------
let total = 0;
let pegas = 0;
let negacoes = 0;
const refutados = [];
// Inclui os arquivos: execução arquivada por bug de harness continua sendo
// um review real, e é justamente onde moram as alucinações já observadas.
for (const dir of ["exp-abc/runs", "exp-abc/archive", "exp-d/runs", "exp-d/archive",
                   "exp-e/runs", "exp-e/archive/protocolo-pipe",
                   "exp-e/archive/protocolo-arquivo-v1"]) {
  const base = path.join(HERE, "../research", dir);
  if (!existsSync(base)) continue;
  for (const rel of globSync("*/findings.json", { cwd: base })) {
    const doc = JSON.parse(readFileSync(path.join(base, rel), "utf8"));
    for (const f of doc.findings ?? doc) {
      total++;
      if (!afirmaInexistencia(`${f.symbol ?? ""} ${f.issue ?? ""}`)) continue;
      negacoes++;
      const ref = refutaInexistencia(f, REPO);
      if (!ref) continue;
      if (ehAlucinacao(f)) {
        pegas++;
        console.log(`  pegou alucinação [${rel}] ${f.symbol} -> ${ref.symbol} @ ${ref.file}:${ref.line}`);
        continue;
      }
      refutados.push({ rel, symbol: f.symbol, prova: `${ref.symbol} @ ${ref.file}:${ref.line}` });
    }
  }
}
console.log(`\nachados analisados: ${total} | afirmam inexistência: ${negacoes} | alucinações pegas: ${pegas}`);
for (const x of refutados) console.log(`  FALSA REFUTAÇÃO [${x.rel}] ${x.symbol} -> ${x.prova}`);
check(refutados.length === 0, `nenhum achado real refutado (${refutados.length} refutações falsas)`);

console.log(falhas === 0 ? "\nTUDO OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
