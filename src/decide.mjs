// Camada de decisão — o Jev responde o espaço gerado por decisions.mjs.
//
// Esta é a aposta do experimento F: em vez de pedir à LLM que DESCUBRA o que
// está errado (busca aberta, cara), transformamos a parte estrutural em
// perguntas fechadas e deixamos o Jev responder centenas delas por centavos.
// Só o que sobrar incerto vai para a LLM.
//
// Estados: safe | suspicious | uncertain | not_applicable
//
// `rejected` NÃO existe aqui de propósito. Nesta fase ninguém descarta nada:
// a camada classifica para decidir *quem investiga*. Descartar achado por
// julgamento probabilístico já nos custou dois defeitos reais (ver
// docs/EXPERIMENTO-ABC.md), e aqui o custo seria pior — o defeito nem chegaria
// a ser procurado.
import { findKey } from "./verify.mjs";

const LOTE = 25; // perguntas por chamada; o fan-out é por candidato
const TIMEOUT_MS = 120_000;

const NIVEIS = [
  "não se aplica: a pergunta não faz sentido para este código",
  "seguro: o código trata isso corretamente, não precisa de investigação",
  "incerto: não dá para decidir com o que está aqui",
  "suspeito: há indício concreto de problema, vale investigar",
];

/** safe/suspicious/uncertain/not_applicable a partir do score contínuo. */
const classificar = (score, risco) => {
  if (score < 0.5) return "not_applicable";
  if (score < 1.5) return "safe";
  if (score < 2.5) return risco >= 0.6 ? "suspicious" : "uncertain";
  return "suspicious";
};

const perguntar = async (key, lote, contexto) => {
  const state = { ...contexto, candidatos: {} };
  const questions = {};
  lote.forEach((c, i) => {
    const id = `c${i}`;
    state.candidatos[id] = {
      assunto: c.subject,
      pergunta: c.question,
      evidencia: c.evidence,
      arquivo: c.file,
      linha: c.line,
    };
    questions[`${id}_v`] = {
      type: "score",
      instructions:
        `Considerando state.diff e a evidência em state.candidatos.${id}, ` +
        `classifique: ${state.candidatos[id].pergunta}`,
      criteria: NIVEIS,
    };
    questions[`${id}_r`] = {
      type: "noul",
      instructions:
        `Se houver problema em state.candidatos.${id}, o impacto seria grave ` +
        `(quebra funcionalidade, vaza dados, corrompe valor) em vez de estilo?`,
    };
  });

  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
};

/**
 * Decide o espaço inteiro.
 *
 * Devolve { decisoes, usage: {calls, input_tokens}, erro? }. Fail-open: se o
 * Jev não responder, todo candidato vira `uncertain` — ou seja, escala tudo
 * para a LLM. Perder a camada degrada a eficiência, nunca a cobertura.
 */
export const decidir = async (candidatos, root, diff) => {
  const key = findKey(root);
  const tudoIncerto = (motivo) => ({
    decisoes: candidatos.map((c) => ({
      ...c, decision: "uncertain", confidence: 0, risk: 0.5, motivo,
    })),
    usage: { calls: 0, input_tokens: 0 },
  });
  if (!key) return tudoIncerto("sem chave do Jev");

  const contexto = { diff: diff.slice(0, 120_000) };
  const decisoes = [];
  let calls = 0;
  let input = 0;

  for (let i = 0; i < candidatos.length; i += LOTE) {
    const lote = candidatos.slice(i, i + LOTE);
    let json;
    try {
      json = await perguntar(key, lote, contexto);
      calls++;
      input += json.usage?.input_tokens ?? 0;
    } catch (e) {
      for (const c of lote) {
        decisoes.push({ ...c, decision: "uncertain", confidence: 0, risk: 0.5, motivo: String(e.message ?? e).slice(0, 120) });
      }
      continue;
    }
    lote.forEach((c, k) => {
      const score = json.answers?.[`c${k}_v`]?.score ?? 1.5;
      const risco = json.answers?.[`c${k}_r`]?.noul ?? 0.5;
      decisoes.push({
        ...c,
        decision: classificar(score, risco),
        confidence: Number(Math.abs(score - 1.5).toFixed(2)), // distância da fronteira
        risk: Number(risco.toFixed(2)),
        score: Number(score.toFixed(2)),
      });
    });
  }
  return { decisoes, usage: { calls, input_tokens: input } };
};

/** O que a LLM precisa ver: suspeito e incerto, do mais arriscado ao menos. */
export const escalar = (decisoes) =>
  decisoes
    .filter((d) => d.decision === "suspicious" || d.decision === "uncertain")
    .sort((a, b) => b.risk - a.risk || b.score - a.score);

/** Resumo para medir "trabalho evitado". */
export const resumo = (decisoes) => {
  const por = {};
  for (const d of decisoes) por[d.decision] = (por[d.decision] ?? 0) + 1;
  const esc = escalar(decisoes).length;
  return {
    total: decisoes.length,
    ...por,
    escalados: esc,
    resolvidos_pelo_jev: decisoes.length - esc,
    pct_evitado: decisoes.length ? Number((1 - esc / decisoes.length).toFixed(3)) : 0,
  };
};
