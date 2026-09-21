#!/usr/bin/env node
// Braço C — Minimal Trigger.
//
// Só o gatilho: sem cost gate, sem contexto preparado, sem protocolo, sem
// subagente, sem Jev Verify. Bloqueia UMA vez no Stop com a mesma instrução
// que o braço A recebe como prompt do usuário, e sai de cena.
//
// O único mecanismo preservado do produto é o session guard — sem ele o
// bloqueio se repetiria para sempre.
import { readFileSync } from "node:fs";
import path from "node:path";
import { claimRun, markReviewed } from "../../../src/session.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const INSTRUCTION = readFileSync(path.resolve(HERE, "../prompts/review-instruction.md"), "utf8");

const silent = () => process.exit(0);

const readStdin = () =>
  new Promise((resolve) => {
    const chunks = [];
    const t = setTimeout(() => resolve(Buffer.concat(chunks).toString()), 3_000);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(t);
      resolve(Buffer.concat(chunks).toString());
    });
  });

const main = async () => {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    silent();
  }
  const claim = claimRun(input.session_id);
  if (!claim.proceed) silent();
  markReviewed(input.session_id);
  process.stdout.write(JSON.stringify({ decision: "block", reason: INSTRUCTION }));
  process.exit(0);
};

main().catch(() => silent());
