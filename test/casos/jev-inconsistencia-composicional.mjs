#!/usr/bin/env node
// CASO REAL — o Jev acerta o fato e erra a conclusão.
//
//   node test/casos/jev-inconsistencia-composicional.mjs
//
// Origem: haiku45-1 do experimento E. O Haiku 4.5 alucinou um achado HIGH
// ("assertAppError não está definida, os testes não compilam"). A definição
// `func assertAppError(...)` ESTÁ no diff que o Jev recebeu — em
// pending_test.go:234, dentro dos 45.283 chars de state.diff.
//
// Medido:
//   valid  = 0.83  -> "o achado descreve um defeito real"
//   contra = 0.29  -> "o diff NÃO contradiz a premissa"
//   existe = 0.75  -> "assertAppError APARECE DEFINIDA no diff"
//
// As duas últimas se contradizem: ele sabe que o símbolo existe e ainda
// assim valida o achado que afirma que não existe.
//
// Diagnóstico: o Jev responde bem pergunta FACTUAL e estreita ("este símbolo
// aparece definido?") e falha no passo COMPOSICIONAL de usar esse fato para
// invalidar o achado. É evidência a favor de decompor a verificação em
// perguntas atômicas derivadas do achado, em vez de perguntar de uma vez
// "este achado é válido?".
//
// Enquanto este caso falhar, o Jev não pode ser apresentado como rede contra
// alucinação de modelo fraco: foi exatamente o que ele deixou passar, com a
// evidência na mão.
import { readFileSync } from "node:fs";
import { findKey } from "../../src/verify.mjs";

const CTX = new URL("../../research/exp-e/runs/haiku45-1/jev-dir/review-context.md", import.meta.url);
const diff = /```diff\n([\s\S]*?)\n```/.exec(readFileSync(CTX, "utf8"))?.[1] ?? "";
const key = findKey("/Users/cesc/Projects/pdv-feat-baseline");
if (!key) {
  console.log("sem TYPESAFE_AI_API_KEY — caso não pode ser avaliado");
  process.exit(0);
}

const f0 = {
  file: "packages/api-go/internal/fiado/page_test.go",
  symbol: "assertAppError",
  issue:
    "Funcao assertAppError nao esta definida em lugar nenhum do pacote, " +
    "entao os testes de internal/fiado nao compilam.",
};

const res = await fetch("https://api.typesafe.ai/v1/systemone", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: "jev-latest",
    state: { diff, findings: { f0 } },
    questions: {
      valid: {
        type: "noul",
        instructions: "O achado state.findings.f0 descreve um defeito REAL no codigo sob revisao (state.diff)?",
      },
      contra: {
        type: "noul",
        instructions:
          "O codigo em state.diff CONTRADIZ DIRETAMENTE a premissa do achado " +
          "state.findings.f0? Responda verdadeiro apenas se o diff mostrar que a " +
          "premissa e factualmente falsa.",
      },
      existe: {
        type: "noul",
        instructions:
          "O simbolo `assertAppError` APARECE DEFINIDO (com a palavra-chave func) " +
          "em algum lugar de state.diff?",
      },
    },
  }),
});
const j = await res.json();
const a = Object.fromEntries(Object.entries(j.answers ?? {}).map(([k, v]) => [k, v.noul ?? 0]));
for (const [k, v] of Object.entries(a)) console.log(`  ${k.padEnd(7)} = ${v.toFixed(3)}`);

const incoerente = a.existe > 0.5 && a.valid > 0.5;
console.log(
  incoerente
    ? "\nFALHA: diz que o símbolo existe E que o achado 'ele não existe' é válido."
    : "\nOK: o Jev deixou de validar um achado que ele mesmo sabe ser falso.",
);
process.exit(incoerente ? 1 : 0);
