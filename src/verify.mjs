// verify — triagem dos achados com o Jev (decision model da TypeSafe).
//
// Padrão generate-then-verify: a LLM gera candidatos (criativa, recall alto,
// ruidosa); o Jev verifica cada um com probabilidade calibrada (barato, não
// inventa). Uma chamada só, com fan-out de perguntas por achado.
//
// O Jev fica FORA do loop da LLM: a triagem não entra no contexto do agente,
// então não é re-cobrada a cada turno.
//
// Regra crítica, validada em teste de estresse (9 achados reais + 8
// alucinações plausíveis): evidência insuficiente NUNCA é tratada como achado
// falso. Foi ela que impediu o descarte do defeito mais grave, que o Jev não
// conseguia confirmar só com o diff.
//
// Sem chave, cai para o modo `mock` em vez de falhar — princípio do fail-open:
// a ausência de uma dependência externa não pode travar o fluxo do agente.
import { readFileSync } from "node:fs";
import path from "node:path";
import { missingEvidence, retrieve } from "./retrieve.mjs";

export const findKey = (start) => {
  const env = (process.env.TYPESAFE_AI_API_KEY ?? "").trim();
  if (env) return env;
  let dir = path.resolve(start);
  for (;;) {
    try {
      const m = /^TYPESAFE_AI_API_KEY\s*=\s*(.+)$/m.exec(readFileSync(path.join(dir, ".env"), "utf8"));
      if (m) return m[1].trim();
    } catch {
      /* sobe */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

const SEVERITY_RANK = { high: 3, med: 2, medium: 2, low: 1 };

const SEVERITY_LEVELS = [
  "não é defeito / observação de estilo",
  "baixa: impacto pequeno ou caso extremo",
  "média: comportamento incorreto em uso normal",
  "alta: quebra a funcionalidade ou vaza dados em produção",
];

// Limiares. `validFloor` veio do teste de estresse: abaixo dele o Jev está
// CONFIANTE de que o achado é falso, e aí evidência baixa não deve salvá-lo —
// uma alucinação ("loop de retry com off-by-one", código inexistente) recebia
// valid=0.02 com evidence=0.23 e escapava como needs_context.
const VALID_MIN = 0.5;
const EVIDENCE_MIN = 0.4;
const VALID_FLOOR = 0.15;

const mockVerify = (findings) => {
  const out = findings.map((f) => ({
    ...f,
    jev: { valid: null, severity_score: SEVERITY_RANK[(f.severity ?? "low").toLowerCase()] ?? 1, evidence_sufficient: null },
    verdict: "confirmed",
  }));
  out.sort((a, b) => b.jev.severity_score - a.jev.severity_score);
  return { findings: out, mode: "mock", usage: {} };
};

/**
 * Contrato de saída (idêntico entre mock e real):
 *   { findings: [{ ...original, jev: {valid, severity_score, evidence_sufficient}, verdict }],
 *     mode: "mock" | "jev", usage }
 * verdict ∈ confirmed | needs_context | rejected
 */
/**
 * Segunda passada determinística para os `needs_context`.
 *
 * O Jev responde needs_context quando o achado cita um arquivo que não está no
 * diff. Essa evidência é buscável no disco — não precisa de LLM. Lemos os
 * arquivos faltantes e perguntamos de novo, só sobre os achados pendentes.
 */
const resolveNeedsContext = async (key, verified, findings, diff, root) => {
  const pending = verified
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.verdict === "needs_context");
  if (pending.length === 0) return { verified, usage: {}, retrieved: [] };

  const wanted = [...new Set(pending.flatMap(({ f }) => missingEvidence(f, diff)))];
  const evidence = retrieve(root, wanted);
  const names = Object.keys(evidence);
  if (names.length === 0) return { verified, usage: {}, retrieved: [] };

  const items = {};
  const questions = {};
  pending.forEach(({ f, i }) => {
    const id = `f${i}`;
    items[id] = { file: f.file, symbol: f.symbol, issue: f.issue };
    questions[`${id}_valid`] = {
      type: "noul",
      instructions: `Com o diff E os arquivos adicionais em state.evidence, o achado state.findings.${id} descreve um defeito REAL?`,
    };
    questions[`${id}_ev`] = {
      type: "noul",
      instructions: `Agora o contexto em state é suficiente para julgar state.findings.${id} com segurança?`,
    };
  });

  let json;
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "jev-latest", state: { diff, evidence, findings: items }, questions }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return { verified, usage: {}, retrieved: names };
    json = await res.json();
  } catch {
    return { verified, usage: {}, retrieved: names };
  }

  const out = [...verified];
  for (const { i } of pending) {
    const id = `f${i}`;
    const valid = json.answers?.[`${id}_valid`]?.noul ?? 0;
    const evid = json.answers?.[`${id}_ev`]?.noul ?? 0;
    if (evid < EVIDENCE_MIN) continue; // segue needs_context, agora com razão
    out[i] = {
      ...out[i],
      jev: { ...out[i].jev, valid: Number(valid.toFixed(2)), evidence_sufficient: Number(evid.toFixed(2)) },
      verdict: valid >= VALID_MIN ? "confirmed" : "rejected",
      resolved_by: "retrieval",
    };
  }
  return { verified: out, usage: json.usage ?? {}, retrieved: names };
};

export const verifyFindings = async (findings, cwd, diff = "") => {
  if (findings.length === 0) return { findings: [], mode: "jev", usage: {} };
  const key = findKey(cwd ?? process.cwd());
  if (!key) return mockVerify(findings); // fail-open: sem chave, não trava

  const items = {};
  const questions = {};
  findings.forEach((f, i) => {
    const id = `f${i}`;
    items[id] = { file: f.file, symbol: f.symbol, issue: f.issue };
    questions[`${id}_valid`] = {
      type: "noul",
      instructions: `O achado state.findings.${id} descreve um defeito REAL no código sob revisão (state.diff)? Considere falso se for opinião de estilo, se o código citado não existir, ou se a premissa estiver errada.`,
    };
    questions[`${id}_sev`] = {
      type: "score",
      instructions: `Assumindo que o achado state.findings.${id} seja real, qual a gravidade do impacto?`,
      criteria: SEVERITY_LEVELS,
    };
    questions[`${id}_ev`] = {
      type: "noul",
      instructions: `O que está em state É SUFICIENTE para julgar o achado state.findings.${id} com segurança? Responda falso se para decidir seria necessário ver código que não está aqui.`,
    };
  });

  let json;
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "jev-latest", state: { diff, findings: items }, questions }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return mockVerify(findings); // fail-open
    json = await res.json();
  } catch {
    return mockVerify(findings); // fail-open: Jev fora do ar não trava o fluxo
  }

  const out = findings.map((f, i) => {
    const id = `f${i}`;
    const valid = json.answers?.[`${id}_valid`]?.noul ?? 0;
    const evidence = json.answers?.[`${id}_ev`]?.noul ?? 0;
    const sev = json.answers?.[`${id}_sev`]?.score ?? 0;
    // ordem importa: confiantemente falso → rejeita; evidência fraca →
    // needs_context (nunca descarta o possivelmente real); senão, validade.
    let verdict;
    if (valid < VALID_FLOOR) verdict = "rejected";
    else if (evidence < EVIDENCE_MIN) verdict = "needs_context";
    else if (valid >= VALID_MIN) verdict = "confirmed";
    else verdict = "rejected";
    return {
      ...f,
      jev: {
        valid: Number(valid.toFixed(2)),
        severity_score: Number(sev.toFixed(2)),
        evidence_sufficient: Number(evidence.toFixed(2)),
      },
      verdict,
    };
  });
  // Exp. 5 — resolve os needs_context com busca determinística, sem LLM.
  const second = await resolveNeedsContext(key, out, findings, diff, cwd ?? process.cwd());
  const final = second.verified;
  final.sort((a, b) => b.jev.severity_score - a.jev.severity_score);
  return {
    findings: final,
    mode: "jev",
    usage: json.usage ?? {},
    retrieval: {
      files: second.retrieved,
      jev_tokens: second.usage?.input_tokens ?? 0,
      resolved: final.filter((f) => f.resolved_by === "retrieval").length,
    },
  };
};

/** Achados que o usuário deve ver: confirmados + os que pedem mais contexto. */
export const keep = (verified) => verified.filter((f) => f.verdict !== "rejected");
