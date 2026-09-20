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

const hookCommand = () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return `node ${path.join(here, "stop-hook.mjs")}`;
};

const isOurs = (entry) =>
  (entry?.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(MARKER));

/** Instala/atualiza a entrada de Stop preservando todo o resto. */
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
  const stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  const ours = { hooks: [{ type: "command", command: hookCommand(), timeout: 60 }] };
  const without = stop.filter((e) => !isOurs(e));
  settings.hooks.Stop = [...without, ours];

  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { file, replaced: without.length !== stop.length };
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
    const registered = (parsed?.hooks?.Stop ?? []).some(isOurs);
    if (!registered) structural.push("hook de Stop não está registrado no settings.json");
  }

  const here = path.dirname(new URL(import.meta.url).pathname);
  const hookFile = path.join(here, "stop-hook.mjs");
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
