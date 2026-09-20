// Config do repo: .jev/config.yaml
//
// Parser de um SUBCONJUNTO de YAML (mapas aninhados, listas de escalares,
// booleanos e números). Deliberadamente sem dependências: o jev-enhancer roda
// dentro do hook de um agente, e toda dependência é risco de quebrar a sessão
// de alguém. Se a config crescer além deste subconjunto, aí sim vale um parser.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_DIR = ".jev";
export const CONFIG_FILE = "config.yaml";

export const DEFAULT_CONFIG_YAML = `# jev-enhancer — configuração do repositório
review:
  passes:
    - correctness
    - tests

# Arquivos de instrução do repo. Viram os invariantes que o review usa.
rules:
  - AGENTS.md
  - CLAUDE.md

# Cost gate: decide DETERMINISTICAMENTE se o diff merece review.
# Roda em toda parada do agente, então precisa ser barato.
gate:
  min_diff_lines: 20
  code_extensions:
    - .go
    - .gd
    - .ts
    - .tsx
    - .js
    - .mjs
    - .py
    - .rs
    - .tscn
  ignore_paths:
    - docs/
    - .jev/

# Checks determinísticos do PRÓPRIO projeto. Cada comando deve sair 0 e
# imprimir JSON. Ferramentas do seu repo não viram dependência daqui.
deterministic:
  commands: []

verify:
  enabled: true
`;

const scalar = (raw) => {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "" || v === "[]") return v === "[]" ? [] : "";
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v.replace(/^["']|["']$/g, "");
};

/**
 * Parser do subconjunto. Para decidir se `chave:` abre um mapa ou uma lista,
 * olha a próxima linha significativa — daí a leitura em duas dimensões
 * (posição + indentação) em vez de uma pilha simples.
 */
export const parseYaml = (text) => {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\t/g, "  "))
    .filter((l) => l.trim() && !l.trim().startsWith("#"));

  const build = (start, indent) => {
    const isList = lines[start] !== undefined && lines[start].trim().startsWith("- ");
    const node = isList ? [] : {};
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      const ind = line.length - line.trimStart().length;
      if (ind < indent) break;
      if (ind > indent) { i++; continue; } // consumido por chamada aninhada
      const content = line.trim();
      if (content.startsWith("- ")) {
        node.push(scalar(content.slice(2)));
        i++;
        continue;
      }
      const m = /^([\w.-]+):\s*(.*)$/.exec(content);
      if (!m) { i++; continue; }
      const [, key, rest] = m;
      if (rest !== "") {
        node[key] = scalar(rest);
        i++;
      } else {
        // olha a próxima linha significativa para saber o tipo do filho
        const next = lines[i + 1];
        if (next === undefined) { node[key] = []; i++; continue; }
        const nextInd = next.length - next.trimStart().length;
        if (nextInd <= ind) { node[key] = []; i++; continue; }
        const [child, consumed] = buildFrom(i + 1, nextInd);
        node[key] = child;
        i = consumed;
      }
    }
    return [node, i];
  };
  const buildFrom = (start, indent) => build(start, indent);
  const [root] = build(0, 0);
  return root;
};

export const findRepoRoot = (from = process.cwd()) => {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
};

export const configPath = (root) => path.join(root, CONFIG_DIR, CONFIG_FILE);

export const loadConfig = (root) => {
  const file = configPath(root);
  if (!existsSync(file)) return null;
  try {
    return parseYaml(readFileSync(file, "utf8"));
  } catch {
    return null; // config ilegível nunca derruba o agente
  }
};

export const writeDefaultConfig = (root) => {
  const dir = path.join(root, CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  const file = configPath(root);
  if (existsSync(file)) return { created: false, file };
  writeFileSync(file, DEFAULT_CONFIG_YAML);
  return { created: true, file };
};
