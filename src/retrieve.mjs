// Experimento 5 — verificação iterativa SEM LLM.
//
// Quando o Jev responde `needs_context`, ele está dizendo "não consigo julgar
// com o que me deram". Nos nossos dados esse caso tem quase sempre a mesma
// forma: o achado cita um arquivo que NÃO está no diff (a config de rota, o
// schema, o arquivo gerado). A evidência que falta é determinística — dá para
// buscar no disco e perguntar de novo, sem acionar a LLM.
//
// Fluxo: needs_context → extrair arquivos citados → ler os ausentes →
// re-verificar. Só escala para a LLM se nem isso resolver.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 60_000;
const MAX_FILES = 6;

/** Caminhos de arquivo citados no texto do achado (heurística por extensão). */
export const citedFiles = (finding) => {
  const text = `${finding.file ?? ""} ${finding.symbol ?? ""} ${finding.issue ?? ""}`;
  const hits = new Set();
  // caminhos com barra e extensão conhecida, ou nomes de arquivo soltos
  const re = /(?:^|[\s"'`(])([\w./-]+\.(?:go|gd|ts|tsx|js|mjs|py|rs|sql|yaml|yml|json|tscn))/g;
  let m;
  while ((m = re.exec(text))) hits.add(m[1].replace(/^\.\//, ""));
  return [...hits];
};

/** Arquivos citados que NÃO aparecem no diff — a evidência que falta. */
export const missingEvidence = (finding, diff) => {
  const inDiff = new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((x) => x[1]));
  return citedFiles(finding).filter(
    (f) => ![...inDiff].some((d) => d === f || d.endsWith(`/${f}`) || f.endsWith(`/${d}`)),
  );
};

/**
 * Busca determinística: resolve o caminho citado dentro do repo e lê o
 * conteúdo. Procura o caminho exato e, se não achar, por sufixo — o achado
 * costuma citar `internal/middleware/routes.go` enquanto o arquivo real está
 * sob `packages/api-go/`.
 */
export const retrieve = (root, wanted) => {
  const out = {};
  for (const rel of wanted.slice(0, MAX_FILES)) {
    let full = path.join(root, rel);
    if (!existsSync(full)) {
      // tenta por sufixo, varrendo diretórios comuns de código
      const found = findBySuffix(root, rel);
      if (!found) continue;
      full = found;
    }
    try {
      if (statSync(full).size > MAX_FILE_BYTES) continue;
      out[rel] = readFileSync(full, "utf8");
    } catch {
      /* ilegível: ignora */
    }
  }
  return out;
};

const SKIP_DIRS = new Set([".git", "node_modules", ".jev", ".claude", "vendor", "dist", "build"]);

const findBySuffix = (root, rel, depth = 0) => {
  if (depth > 6) return null;
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const deeper = findBySuffix(full, rel, depth + 1);
      if (deeper) return deeper;
    } else if (full.endsWith(`/${rel}`) || name === path.basename(rel)) {
      // confere o sufixo completo quando o citado tem diretórios
      if (rel.includes("/") ? full.endsWith(`/${rel}`) : true) return full;
    }
  }
  return null;
};
