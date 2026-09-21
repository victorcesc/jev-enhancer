// verify — triagem dos achados com o Jev (decision model da TypeSafe).
//
// Padrão generate-then-verify: a LLM gera candidatos (criativa, recall alto,
// ruidosa); o Jev verifica cada um com probabilidade calibrada (barato, não
// inventa). Uma chamada só, com fan-out de perguntas por achado.
//
// O Jev fica FORA do loop da LLM: a triagem não entra no contexto do agente,
// então não é re-cobrada a cada turno.
//
// POLÍTICA CONSERVADORA (desde o experimento A/B/C): o Jev não apaga achado.
// Ele classifica. O único veredito que remove é `contradicted`, e ele exige
// que o retrieval tenha LIDO do disco um arquivo que desminta a premissa.
//
// O motivo é medido, não teórico: em 3 execuções de campo a política antiga
// rejeitou 2 achados e os DOIS eram defeitos reais; nenhum falso positivo foi
// capturado, porque nenhum dos 9 reviews alucinou. Ausência de evidência
// nunca é evidência de ausência.
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

// Limiares.
//
// `VALID_FLOOR` foi REMOVIDO da política. Ele vinha do teste de estresse, onde
// alucinações plantadas recebiam valid≈0.02 e precisavam ser cortadas. Em
// campo o cenário não se materializou: nas 9 execuções do experimento A/B/C
// nenhum review alucinou, e o Jev rejeitou 2 achados — os DOIS eram defeitos
// reais verificados no código. Precisão ganha: zero. Defeitos destruídos: 2.
//
// Política nova: o Jev nunca apaga um achado por julgamento probabilístico.
// Só `contradicted` remove, e exige EVIDÊNCIA POSITIVA do disco (ver
// resolveNeedsContext) — não a mera ausência dela.
const VALID_MIN = 0.5;
const EVIDENCE_MIN = 0.4;
// Alto de propósito: remover um achado é a ação destrutiva deste sistema.
const CONTRADICTION_MIN = 0.7;

const mockVerify = (findings) => {
  const out = findings.map((f) => ({
    ...f,
    jev: { valid: null, severity_score: SEVERITY_RANK[(f.severity ?? "low").toLowerCase()] ?? 1, evidence_sufficient: null },
    verdict: "needs_context",
    reason: "sem chave do Jev: nenhuma triagem foi feita",
  }));
  out.sort((a, b) => b.jev.severity_score - a.jev.severity_score);
  return { findings: out, mode: "mock", usage: {} };
};

/**
 * Contrato de saída (idêntico entre mock e real):
 *   { findings: [{ ...original, jev: {valid, severity_score, evidence_sufficient},
 *                  verdict, reason }],
 *     mode: "mock" | "jev", usage }
 * verdict ∈ confirmed | needs_context | contradicted
 * `reason` é sempre preenchido: veredito sem motivo registrado não é auditável.
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
    // A pergunta que autoriza remoção. Deliberadamente não é "você duvida?":
    // é "o código que eu li DIZ O CONTRÁRIO?". Duvidar não apaga achado;
    // só evidência positiva apaga.
    questions[`${id}_contra`] = {
      type: "noul",
      instructions:
        `O conteúdo dos arquivos em state.evidence CONTRADIZ DIRETAMENTE a premissa ` +
        `do achado state.findings.${id}? Responda verdadeiro apenas se o código lido ` +
        `mostrar que a premissa é factualmente falsa (ex.: o achado diz que algo não ` +
        `existe e o arquivo mostra que existe). Responda falso se você apenas duvida, ` +
        `se o arquivo não trata do assunto, ou se a evidência é inconclusiva.`,
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
  for (const { f, i } of pending) {
    const id = `f${i}`;
    const valid = json.answers?.[`${id}_valid`]?.noul ?? 0;
    const evid = json.answers?.[`${id}_ev`]?.noul ?? 0;
    const contra = json.answers?.[`${id}_contra`]?.noul ?? 0;

    // Os arquivos que ESTE achado citava e que de fato foram lidos do disco.
    // Sem isso, `contradicted` viraria "não achei o arquivo, logo é falso" —
    // exatamente a falsa rejeição que já nos custou um defeito real antes.
    const lidos = missingEvidence(f, diff).filter((n) => n in evidence);
    const base = { ...out[i], jev: { ...out[i].jev, valid: Number(valid.toFixed(2)), evidence_sufficient: Number(evid.toFixed(2)) } };

    if (lidos.length === 0) {
      out[i] = { ...base, verdict: "needs_context", reason: "caminho citado não foi encontrado no repositório" };
    } else if (contra >= CONTRADICTION_MIN) {
      out[i] = {
        ...base,
        verdict: "contradicted",
        reason: `${lidos.join(", ")} contradiz a premissa (contra=${contra.toFixed(2)})`,
        resolved_by: "retrieval",
      };
    } else if (evid >= EVIDENCE_MIN && valid >= VALID_MIN) {
      out[i] = { ...base, verdict: "confirmed", reason: `confirmado após ler ${lidos.join(", ")}`, resolved_by: "retrieval" };
    } else {
      out[i] = { ...base, verdict: "needs_context", reason: `li ${lidos.join(", ")} e continua inconclusivo` };
    }
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
    // O diff também é evidência positiva. Sem esta pergunta, um achado cuja
    // premissa o PRÓPRIO diff desmente nunca poderia ser removido — a segunda
    // passada só busca arquivos de FORA do diff, então nunca rodaria.
    questions[`${id}_contra`] = {
      type: "noul",
      instructions:
        `O código em state.diff CONTRADIZ DIRETAMENTE a premissa do achado ` +
        `state.findings.${id}? Responda verdadeiro apenas se o diff mostrar que a ` +
        `premissa é factualmente falsa — o achado afirma que algo não existe e o diff ` +
        `mostra que existe, ou descreve um trecho de código que não está lá. Responda ` +
        `falso se você apenas duvida, ou se o diff não basta para desmentir.`,
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
    const contra = json.answers?.[`${id}_contra`]?.noul ?? 0;
    // A ÚNICA saída que remove é `contradicted`, e ela exige que o diff
    // desminta a premissa — não que o Jev duvide dela. Duvidar vira
    // `needs_context`, que continua visível para o humano.
    let verdict, reason;
    if (contra >= CONTRADICTION_MIN) {
      verdict = "contradicted";
      reason = `o diff desmente a premissa (contra=${contra.toFixed(2)}, valid=${valid.toFixed(2)})`;
    } else if (evidence < EVIDENCE_MIN) {
      verdict = "needs_context";
      reason = "evidência insuficiente no diff para julgar";
    } else if (valid >= VALID_MIN) {
      verdict = "confirmed";
      reason = `Jev confirma (valid=${valid.toFixed(2)})`;
    } else {
      verdict = "needs_context";
      reason = `Jev duvida (valid=${valid.toFixed(2)}) mas nada no código contradiz`;
    }
    return {
      ...f,
      jev: {
        valid: Number(valid.toFixed(2)),
        severity_score: Number(sev.toFixed(2)),
        evidence_sufficient: Number(evidence.toFixed(2)),
      },
      verdict,
      reason,
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

/**
 * Achados que o usuário deve ver.
 *
 * Só `contradicted` é removido — e esse veredito exige que o retrieval tenha
 * LIDO um arquivo do disco que desminta a premissa. Dúvida probabilística do
 * Jev vira `needs_context` e continua visível: quem decide descartar é o
 * humano, não um limiar.
 */
export const keep = (verified) => verified.filter((f) => f.verdict !== "contradicted");
