// Session guard.
//
// Sem isto o ciclo não fecha: o hook de Stop bloqueia uma vez para apresentar
// os achados, o agente apresenta, para de novo — e o hook dispararia outra vez,
// em loop. Duas travas, de propósito redundantes:
//
//   1. flag `reviewed` — o caminho normal: já revisou nesta sessão, sai.
//   2. limite defensivo de execuções — rede para o caso do flag não ser
//      gravado (disco cheio, permissão, sessão sem id). Sem ele, uma falha
//      de escrita vira loop infinito na sessão de alguém.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_EXECUTIONS = 3;

const dir = (sessionId) => path.join(os.tmpdir(), "jev-enhancer", sessionId || "sem-sessao");
const file = (sessionId) => path.join(dir(sessionId), "state.json");

export const readState = (sessionId) => {
  try {
    return JSON.parse(readFileSync(file(sessionId), "utf8"));
  } catch {
    return { reviewed: false, executions: 0 };
  }
};

export const writeState = (sessionId, state) => {
  try {
    mkdirSync(dir(sessionId), { recursive: true });
    writeFileSync(file(sessionId), JSON.stringify(state));
    return true;
  } catch {
    return false; // estado perdido é aceitável; sessão travada não
  }
};

/**
 * Registra mais uma execução e diz se o hook deve seguir.
 * Devolve { proceed, reason, state }.
 */
export const claimRun = (sessionId) => {
  const state = readState(sessionId);
  const next = { ...state, executions: (state.executions ?? 0) + 1 };
  writeState(sessionId, next);

  if (state.reviewed) return { proceed: false, reason: "already_reviewed", state: next };
  if (next.executions > MAX_EXECUTIONS)
    return { proceed: false, reason: "execution_limit", state: next };
  return { proceed: true, reason: null, state: next };
};

export const markReviewed = (sessionId) => {
  const state = readState(sessionId);
  writeState(sessionId, { ...state, reviewed: true });
};

export const sessionDir = dir;
