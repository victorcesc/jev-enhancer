// verify — triagem dos achados.
//
// MILESTONE 1: implementação SIMPLIFICADA de propósito. O objetivo agora é
// provar que o ciclo automático fecha (sem loop, sem atrapalhar o agente).
// O verificador real (Jev: valid / severity / evidence_sufficient) entra
// depois, trocando só o corpo de `verifyFindings` — o contrato de saída já é
// o definitivo.
//
// Regra que NÃO muda quando o real entrar: evidência insuficiente nunca é
// tratada como achado falso. No teste de estresse, foi exatamente essa regra
// que impediu o descarte do defeito mais grave.
import { readFileSync } from "node:fs";
import path from "node:path";

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

/**
 * Contrato de saída (estável entre o mock e o real):
 *   { findings: [{ ...original, jev: {valid, severity, evidence_sufficient}, verdict }],
 *     mode: "mock" | "jev", usage }
 * verdict ∈ confirmed | needs_context | rejected
 */
export const verifyFindings = async (findings, cwd) => {
  // MOCK: sem chamada externa. Confirma tudo e ordena por severidade
  // declarada, preservando o formato que o real vai devolver.
  const out = findings.map((f) => {
    const rank = SEVERITY_RANK[(f.severity ?? "low").toLowerCase()] ?? 1;
    return {
      ...f,
      jev: { valid: null, severity_score: rank, evidence_sufficient: null },
      verdict: "confirmed",
    };
  });
  out.sort((a, b) => b.jev.severity_score - a.jev.severity_score);
  return { findings: out, mode: "mock", usage: {} };
};

/** Achados que o usuário deve ver: confirmados + os que pedem mais contexto. */
export const keep = (verified) => verified.filter((f) => f.verdict !== "rejected");
