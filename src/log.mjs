// Observabilidade.
//
// O estado mais perigoso não é "rodou e não achou nada" — é "nunca disparou e
// ninguém percebeu". Perdemos duas rodadas inteiras de benchmark assim. Cada
// execução deixa rastro aqui, e `jev status` lê daqui.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const LOG_FILE = "runs.jsonl";

export const logPath = (root) => path.join(root, ".jev", LOG_FILE);

export const record = (root, entry) => {
  try {
    mkdirSync(path.join(root, ".jev"), { recursive: true });
    appendFileSync(logPath(root), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* log é conveniência: nunca derruba o fluxo */
  }
};

export const readRuns = (root) => {
  const file = logPath(root);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};
