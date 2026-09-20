// status — responde "o review aconteceu?" sem ambiguidade.
//
// Os quatro estados são distintos de propósito. O mais importante é
// `never_run`: uma ferramenta que nunca disparou parece igual a uma que rodou
// e não achou nada, e essa confusão já nos custou duas rodadas de benchmark.
//
// Cuidado de leitura: depois de um review, as paradas seguintes da mesma
// sessão registram `skipped/already_reviewed` — são NO-OPS da guarda, não o
// desfecho do trabalho. Reportá-las como o estado atual esconderia o review
// que de fato ocorreu. Por isso o estado vem do último desfecho SUBSTANTIVO.
import { readRuns } from "./log.mjs";

export const STATES = ["never_run", "skipped", "completed", "failed"];

const NOOP_REASONS = new Set(["already_reviewed", "execution_limit"]);
const isNoop = (r) => r.status === "skipped" && NOOP_REASONS.has(r.reason);

export const computeStatus = (root) => {
  const runs = readRuns(root);
  if (runs.length === 0) return { state: "never_run", runs: 0, last: null, noops: 0 };

  const substantive = runs.filter((r) => !isNoop(r));
  const noops = runs.length - substantive.length;
  if (substantive.length === 0) {
    // só no-ops: a guarda disparou, mas nenhum review chegou a ser avaliado
    return { state: "skipped", runs: runs.length, last: runs[runs.length - 1], noops };
  }
  const last = substantive[substantive.length - 1];
  const state = STATES.includes(last.status) ? last.status : "failed";
  return { state, runs: runs.length, last, noops };
};

export const renderStatus = (root) => {
  const { state, runs, last, noops } = computeStatus(root);
  const lines = [];

  if (state === "never_run") {
    return [
      "estado: never_run",
      "",
      "O jev-enhancer nunca foi executado neste repositório.",
      "Se você já usou o agente aqui depois de instalar, isso indica que o",
      "adapter não está disparando — rode: jev apply claude",
    ].join("\n");
  }

  lines.push(`estado: ${state}`);
  lines.push(`última execução: ${last.at}`);
  if (last.gate) lines.push(`  gate: ${last.gate}${last.reason ? ` (${last.reason})` : ""}`);
  if (last.stats)
    lines.push(`  diff: ${last.stats.changed_lines} linhas em ${last.stats.relevant_files} arquivo(s) de código`);
  if (last.rules?.length) lines.push(`  invariantes usados: ${last.rules.join(", ")}`);
  if (last.deterministic_findings) lines.push(`  achados determinísticos: ${last.deterministic_findings}`);
  if (last.findings !== undefined) lines.push(`  achados: ${last.findings} → mantidos após triagem: ${last.verified ?? "?"}`);
  if (last.error) lines.push(`  erro: ${last.error}`);

  lines.push(`registros totais: ${runs}${noops ? ` (${noops} no-op da guarda de sessão)` : ""}`);

  if (state === "skipped") {
    lines.push("");
    lines.push("Nenhum review foi executado ainda: o gate considerou as mudanças");
    lines.push("insuficientes. Ajuste gate.min_diff_lines em .jev/config.yaml se");
    lines.push("quiser revisar diffs menores.");
  }
  return lines.join("\n");
};
