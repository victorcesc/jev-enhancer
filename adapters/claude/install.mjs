// Instalação do adapter no Claude Code.
//
// Duas exigências que vêm de erro já cometido:
//
// 1. IDEMPOTENTE e não-destrutiva. O settings.json do usuário costuma ter
//    hooks de outras ferramentas. Só mexemos na nossa entrada, identificada
//    por marcador; tudo o mais é preservado.
// 2. SELF-TEST que separa DUAS naturezas de falha:
//    - estrutural (hook não registrado, arquivo ausente, JSON inválido):
//      a instalação FALHA, porque está errada;
//    - dependência externa indisponível (Jev fora do ar, chave ausente):
//      DIAGNÓSTICO claro, mas a instalação segue válida — ela está
//      estruturalmente correta e volta a funcionar quando a dependência voltar.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findKey } from "../../src/verify.mjs";

export const MARKER = "jev-enhancer";

const settingsPath = (scope, root) =>
  scope === "project"
    ? path.join(root, ".claude", "settings.json")
    : path.join(os.homedir(), ".claude", "settings.json");

const hookCommand = (file) => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return `node ${path.join(here, file)}`;
};

const isOurs = (entry) =>
  (entry?.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARKER));

/**
 * Instala/atualiza NOSSAS entradas preservando todo o resto.
 *
 * Dois hooks desde o roteiro pós-experimento A/B/C:
 *   SessionStart — o contrato ("review faz parte do pronto"). Gatilho principal.
 *   Stop         — fallback, para quando o agente esquece.
 */
export const install = (scope, root) => {
  const file = settingsPath(scope, root);
  mkdirSync(path.dirname(file), { recursive: true });

  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      // settings inválido é erro ESTRUTURAL: não sobrescrevemos o arquivo de
      // alguém às cegas.
      throw new Error(`settings.json existente é JSON inválido (${file}): ${e.message}`);
    }
  }

  settings.hooks = settings.hooks ?? {};
  let replaced = false;
  for (const [evento, script, timeout] of [
    ["SessionStart", "session-start-hook.mjs", 15],
    ["Stop", "stop-hook.mjs", 60],
  ]) {
    const atuais = Array.isArray(settings.hooks[evento]) ? settings.hooks[evento] : [];
    const outros = atuais.filter((e) => !isOurs(e));
    replaced = replaced || outros.length !== atuais.length;
    settings.hooks[evento] = [
      ...outros,
      { hooks: [{ type: "command", command: hookCommand(script), timeout }] },
    ];
  }

  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { file, replaced };
};

/**
 * Self-test. Devolve { structural: [...], external: [...] }.
 * Falhas estruturais invalidam a instalação; externas são diagnóstico.
 */
export const selfTest = (scope, root) => {
  const structural = [];
  const external = [];
  const file = settingsPath(scope, root);

  // --- estrutural: o hook está registrado e é executável? ---
  if (!existsSync(file)) {
    structural.push(`settings.json não foi criado em ${file}`);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      structural.push(`settings.json ficou inválido: ${e.message}`);
    }
    for (const evento of ["SessionStart", "Stop"]) {
      if (!(parsed?.hooks?.[evento] ?? []).some(isOurs)) {
        structural.push(`hook de ${evento} não está registrado no settings.json`);
      }
    }
  }

  const here = path.dirname(new URL(import.meta.url).pathname);
  const hookFile = path.join(here, "stop-hook.mjs");
  const startFile = path.join(here, "session-start-hook.mjs");
  if (!existsSync(startFile)) structural.push("session-start-hook.mjs não encontrado");
  if (!existsSync(hookFile)) {
    structural.push(`arquivo do hook não encontrado: ${hookFile}`);
  } else {
    // o hook precisa ao menos parsear e sair 0 com entrada vazia
    const r = spawnSync("node", ["--check", hookFile], { encoding: "utf8", timeout: 15_000 });
    if (r.status !== 0) structural.push(`hook não compila: ${(r.stderr || "").slice(0, 200)}`);
  }

  // --- externo: chave e disponibilidade do Jev ---
  const key = findKey(root);
  if (!key) {
    external.push("TYPESAFE_AI_API_KEY não encontrada (ambiente ou .env) — a triagem do Jev ficará indisponível");
  }

  return { structural, external, settings_file: file };
};

/** Ping ao Jev. Nunca lança: indisponibilidade é diagnóstico, não erro fatal. */
export const pingJev = async (root) => {
  const key = findKey(root);
  if (!key) return { ok: false, reason: "sem chave" };
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "jev-latest",
        state: { ping: "jev-enhancer self-test" },
        questions: { ok: { type: "noul", instructions: "Is this a self-test ping?" } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    await res.json();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e.message ?? e).slice(0, 120) };
  }
};
