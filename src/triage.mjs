// Triagem garantida — roda por código, não por obediência do modelo.
//
// Origem: no experimento E, o subagente do Haiku 4.5 gastou 15 turnos
// analisando e NUNCA chamou o verify. Duas execuções de duas. Ele chegou a
// conferir se o cli.mjs existia e voltou a investigar: não é erro de escape
// de JSON, é que um modelo fraco não converge da análise para a entrega.
//
// Resultado: 15 turnos de análise jogados fora, porque era o `verify` que
// gravava os achados.
//
// A correção não é um prompt melhor. O worker agora só GRAVA
// `.jev/findings.json` (ferramenta nativa, sem shell), e a triagem passou a
// ser responsabilidade de quem sempre executa: o hook.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifyFindings, keep } from "./verify.mjs";
import { record } from "./log.mjs";

const arquivo = (root, nome) => path.join(root, ".jev", nome);

/**
 * Onde os achados podem ter sido gravados.
 *
 * O caminho pedido é `.jev/findings.json`, mas um worker gravou em
 * `.findings.json` na raiz. Depender do modelo acertar o caminho é a mesma
 * fragilidade que já custou 15 turnos de análise quando ele não chamava o
 * verify — então aceitamos os vizinhos óbvios em vez de perder o trabalho.
 */
const CANDIDATOS = ["findings.json", "../.findings.json", "../findings.json"];

const acharBrutos = (root) => {
  for (const nome of CANDIDATOS) {
    const p = arquivo(root, nome);
    if (existsSync(p)) return p;
  }
  return null;
};

/** Há achados gravados que ainda não passaram pela triagem? */
export const precisaTriagem = (root) => {
  const brutos = acharBrutos(root);
  if (!brutos) return false;
  const triados = arquivo(root, "findings-verified.json");
  if (!existsSync(triados)) return true;
  try {
    return statSync(brutos).mtimeMs > statSync(triados).mtimeMs;
  } catch {
    return true;
  }
};

/**
 * Roda a triagem sobre `.jev/findings.json` e grava o resultado.
 *
 * Devolve { total, kept, verdicts, mode } ou null se não havia o que triar.
 * Toda falha é engolida: triagem é melhoria, não pode travar a sessão.
 */
export const triar = async (root) => {
  const origem = acharBrutos(root);
  if (!origem) return null;
  let findings;
  try {
    const bruto = JSON.parse(readFileSync(origem, "utf8"));
    findings = Array.isArray(bruto) ? bruto : (bruto.findings ?? []);
  } catch {
    return null;
  }
  if (!Array.isArray(findings) || findings.length === 0) return null;

  // O diff congelado na preparação é a evidência que a triagem usa.
  let diff = "";
  try {
    const ctx = readFileSync(arquivo(root, "review-context.md"), "utf8");
    diff = /```diff\n([\s\S]*?)\n```/.exec(ctx)?.[1] ?? "";
  } catch {
    /* sem contexto: julga só pelo texto do achado */
  }

  try {
    const t0 = Date.now();
    const { findings: verificados, mode, usage } = await verifyFindings(findings, root, diff);
    const mantidos = keep(verificados);
    const verdicts = verificados.reduce((a, f) => ({ ...a, [f.verdict]: (a[f.verdict] ?? 0) + 1 }), {});
    writeFileSync(
      arquivo(root, "findings-verified.json"),
      JSON.stringify({ mode, verdicts, findings: mantidos }, null, 2),
    );
    record(root, {
      status: "completed", stage: "verify", mode, trigger: "hook",
      findings: findings.length, verified: mantidos.length, verdicts,
      jev_tokens: usage?.input_tokens ?? 0, ms: Date.now() - t0,
    });
    return { total: findings.length, kept: mantidos.length, verdicts, mode };
  } catch (e) {
    record(root, { status: "failed", stage: "verify", trigger: "hook", error: String(e.message ?? e).slice(0, 200) });
    return null;
  }
};
