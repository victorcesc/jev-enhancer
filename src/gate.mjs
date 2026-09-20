// Cost gate — decide DETERMINISTICAMENTE se o diff merece um review.
//
// Roda em TODA parada do agente, inclusive nas que vão ser reprovadas. Então
// só pode usar git e leitura de config: nada de LLM, nada de rede.
//
// Por que existe: um review custa ~120k tokens. Sem gate, uma correção de uma
// linha ou um ajuste de doc pagaria o mesmo preço de uma feature inteira, e a
// economia da ferramenta evapora.
import { spawnSync } from "node:child_process";
import path from "node:path";

const git = (root, args, timeoutMs = 5000) => {
  try {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: timeoutMs });
    return r.status === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
};

/** Mudanças do branch contra a base, incluindo não-commitadas. */
export const collectDiff = (root, base) => {
  const committed = base ? git(root, ["diff", `${base}...HEAD`]) ?? "" : "";
  const working = git(root, ["diff", "HEAD"]) ?? "";
  const untracked = (git(root, ["ls-files", "--others", "--exclude-standard"]) ?? "")
    .split("\n")
    .filter(Boolean);
  // arquivos novos não aparecem em `git diff`; incluímos o conteúdo deles
  let extra = "";
  for (const f of untracked.slice(0, 50)) {
    const content = git(root, ["show", `:${f}`]) ?? null;
    void content;
    extra += `\n--- /dev/null\n+++ b/${f}\n`;
  }
  return { diff: committed + working + extra, untracked };
};

const filesOf = (diff) => [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);

const countChangedLines = (diff) =>
  diff.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !/^(\+\+\+|---)/.test(l))
    .length;

/**
 * Avalia o gate. Devolve { pass, reason, stats }.
 * `reason` explica a decisão em linguagem de log, não de usuário.
 */
export const evaluateGate = (root, config, diffText) => {
  const gate = config?.gate ?? {};
  const minLines = Number.isFinite(gate.min_diff_lines) ? gate.min_diff_lines : 20;
  const exts = Array.isArray(gate.code_extensions) ? gate.code_extensions : [];
  const ignore = Array.isArray(gate.ignore_paths) ? gate.ignore_paths : [];

  const files = filesOf(diffText);
  const relevant = files.filter(
    (f) => !ignore.some((p) => f.startsWith(p)) && (exts.length === 0 || exts.some((e) => f.endsWith(e))),
  );
  const lines = countChangedLines(diffText);
  const stats = { files: files.length, relevant_files: relevant.length, changed_lines: lines };

  if (diffText.trim() === "") return { pass: false, reason: "empty_diff", stats };
  if (relevant.length === 0) return { pass: false, reason: "no_code_files", stats };
  if (lines < minLines) return { pass: false, reason: `below_min_lines(${lines}<${minLines})`, stats };
  return { pass: true, reason: "passed", stats };
};

export const defaultBase = (root) => {
  for (const ref of ["origin/main", "main", "origin/master", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", ref], 3000) !== undefined) return ref;
  }
  return undefined;
};

export const gitRoot = (from) => {
  const out = git(from, ["rev-parse", "--show-toplevel"], 3000);
  return out ? out.trim() : path.resolve(from);
};
