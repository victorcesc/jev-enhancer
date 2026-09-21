// Trace de decisões — só com JEV_DEBUG=1.
//
// Existe por causa do fail-open: em produção toda falha sai em silêncio, o que
// é certo para não travar a sessão de ninguém e péssimo para depurar. O trace
// registra o CAMINHO (cada ponto de decisão), enquanto runs.jsonl registra
// só o DESFECHO.
//
// Perdemos duas rodadas de benchmark com um servidor MCP que nunca subia e
// falhava calado. Isto é a resposta a esse erro.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const enabled = () => (process.env.JEV_DEBUG ?? "") !== "";

let t0 = null;

export const trace = (root, step, detail = {}) => {
  if (!enabled()) return;
  try {
    const now = Date.now();
    t0 ??= now;
    mkdirSync(path.join(root, ".jev"), { recursive: true });
    appendFileSync(
      path.join(root, ".jev", "trace.jsonl"),
      JSON.stringify({
        at: new Date(now).toISOString(),
        ms_since_start: now - t0,
        step,
        ...detail,
      }) + "\n",
    );
  } catch {
    /* trace nunca pode atrapalhar */
  }
};

/** Linha legível para acompanhar ao vivo com `tail -f`. */
export const traceLine = (entry) => {
  const d = { ...entry };
  delete d.at;
  delete d.step;
  delete d.ms_since_start;
  const extra = Object.entries(d)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ");
  return `${String(entry.ms_since_start).padStart(6)}ms  ${entry.step.padEnd(10)} ${extra}`;
};
