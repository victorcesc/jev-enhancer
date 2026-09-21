// Decision space — transforma um diff em muitas decisões pequenas e checáveis.
//
// A hipótese do experimento F: code review é hoje uma tarefa de DESCOBERTA
// aberta ("ache o que estiver errado"), que é cara porque a LLM precisa varrer
// o espaço inteiro. Se a parte estrutural virar perguntas fechadas, o Jev
// responde centenas delas por centavos e a LLM só investiga o que sobrou.
//
// Este módulo é a metade determinística: NÃO decide se algo é defeito, só
// levanta *onde vale perguntar*. Quem decide é a camada seguinte.
//
// Regra de projeto: candidato barato demais é melhor que candidato ausente.
// Um falso candidato custa uma pergunta ao Jev (frações de centavo); um
// candidato que não existe é um defeito que ninguém vai procurar.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SKIP = new Set([".git", "node_modules", ".jev", ".jev-exp", ".claude", "vendor", "dist", "build", "target"]);
const CODE = /\.(go|rs|ts|tsx|js|mjs|py|sql)$/;

/* ---------------------------------------------------------------- diff --- */

/** Divide o diff unificado em arquivos com as linhas ADICIONADAS numeradas. */
export const parseDiff = (diff) => {
  const arquivos = [];
  let atual = null;
  let linha = 0;
  for (const raw of String(diff ?? "").split("\n")) {
    const novo = /^\+\+\+ b\/(.+)$/.exec(raw);
    if (novo) {
      atual = { file: novo[1], add: [], del: [] };
      arquivos.push(atual);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      linha = Number(hunk[1]);
      continue;
    }
    if (!atual) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      atual.add.push({ n: linha++, text: raw.slice(1) });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      atual.del.push({ text: raw.slice(1) });
    } else {
      linha++;
    }
  }
  return arquivos;
};

/* ------------------------------------------------------------ repo util -- */

const listar = function* (dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const nome of entries) {
    if (SKIP.has(nome)) continue;
    const full = path.join(dir, nome);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* listar(full, depth + 1);
    else if (CODE.test(nome) && st.size < 1_000_000) yield full;
  }
};

const lerRepo = (root) => {
  const out = [];
  for (const f of listar(root)) {
    try {
      out.push({ file: path.relative(root, f), texto: readFileSync(f, "utf8") });
    } catch {
      /* ilegível */
    }
  }
  return out;
};

/* ------------------------------------------------------------- regras ---- */

const ARQUIVOS_REGRA = ["AGENTS.md", "CLAUDE.md", ".cursor/rules/RULES.md", "RULES.md"];

/** Frases imperativas dos arquivos de regra do repo. Viram decisões. */
export const lerRegras = (root) => {
  const out = [];
  for (const nome of ARQUIVOS_REGRA) {
    const p = path.join(root, nome);
    if (!existsSync(p)) continue;
    let texto;
    try {
      texto = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const l of texto.split("\n")) {
      const t = l.replace(/^[-*\d.\s]+/, "").trim();
      // Teto de 180 descartava as regras MAIS específicas, que são as mais
      // longas: "Avoid single-letter names…" tem 312 chars e sumia.
      if (t.length < 25 || t.length > 420) continue;
      // imperativo / proibição: é onde mora regra acionável
      if (!/\b(sempre|nunca|não |nao |deve|evite|use|prefira|proíb|proib|must|never|always|avoid|prefer|require)\b/i.test(t)) continue;
      out.push({ fonte: nome, regra: t });
    }
  }
  return out;
};

/* --------------------------------------------------------- geradores ----- */

let seq = 0;
const cand = (kind, subject, question, evidence, file, line) => ({
  id: `${kind}-${++seq}`,
  kind,
  subject,
  question,
  evidence: evidence.filter(Boolean).slice(0, 6),
  file,
  line: line ?? 0,
});

/** SQL mudou e o artefato gerado não acompanhou. */
const gerSqlArtifact = (root, arquivos) => {
  const sql = arquivos.filter((a) => a.file.endsWith(".sql") && a.add.length);
  if (!sql.length) return [];
  const usaSqlc = existsSync(path.join(root, "packages/api-go/sqlc.yaml")) ||
    existsSync(path.join(root, "sqlc.yaml")) ||
    existsSync(path.join(root, "sqlc.json"));
  const out = [];
  for (const a of sql) {
    const nomes = [...a.add.flatMap((l) => [...l.text.matchAll(/--\s*name:\s*(\w+)/g)].map((m) => m[1]))];
    const base = path.basename(a.file, ".sql");
    const gerado = [...listar(root)].some((f) => path.basename(f) === `${base}.sql.go`);
    out.push(
      cand("db", a.file,
        `O arquivo SQL ${a.file} mudou. O código gerado correspondente existe e está atualizado?`,
        [`${nomes.length} query(s) declarada(s): ${nomes.join(", ")}`,
         usaSqlc ? "o repo usa sqlc (sqlc.yaml presente)" : null,
         gerado ? `artefato ${base}.sql.go encontrado` : `artefato ${base}.sql.go NÃO encontrado no repo`],
        a.file, 1),
    );
    for (const n of nomes) {
      const usado = [...listar(root)].some((f) => {
        try { return readFileSync(f, "utf8").includes(n); } catch { return false; }
      });
      if (!usado) continue;
      out.push(
        cand("db", n,
          `A query ${n} é chamada pelo código. Os tipos gerados que ela exige existem?`,
          [`declarada em ${a.file}`, `nome referenciado em outro arquivo do repo`],
          a.file, 1),
      );
    }
  }
  return out;
};

/** Subquery agregada sem predicado — varre mais do que devia. */
const gerSqlSemFiltro = (arquivos) => {
  const out = [];
  for (const a of arquivos.filter((x) => x.file.endsWith(".sql"))) {
    const texto = a.add.map((l) => l.text).join("\n");
    // `[^()]` rejeitava a própria subquery, porque SUM(amount) tem parênteses.
    for (const m of texto.matchAll(/\(\s*SELECT\b[\s\S]*?\bFROM\s+(\w+)\b[\s\S]*?\bGROUP\s+BY\b[\s\S]*?\)/gi)) {
      const trecho = m[0];
      if (/\bWHERE\b/i.test(trecho)) continue;
      out.push(
        cand("db", m[1],
          `A subquery sobre ${m[1]} agrega sem WHERE. Ela deveria ser filtrada por tenant/linha?`,
          [`trecho: ${trecho.replace(/\s+/g, " ").slice(0, 120)}`, "não há predicado dentro da subquery"],
          a.file, 1),
      );
    }
  }
  return out;
};

/** Retorno múltiplo com `_`: alguma informação foi descartada. */
const gerRetornoDescartado = (arquivos) => {
  const out = [];
  for (const a of arquivos) {
    for (const l of a.add) {
      const m = /(\w+)\s*,\s*_\s*:?=\s*(\w+)\(/.exec(l.text) || /_\s*,\s*(\w+)\s*:?=\s*(\w+)\(/.exec(l.text);
      if (!m) continue;
      out.push(
        cand("errors", m[2],
          `O segundo retorno de ${m[2]} é descartado com \`_\`. Ele carrega informação que importa?`,
          [`${a.file}:${l.n}`, l.text.trim().slice(0, 120)],
          a.file, l.n),
      );
    }
  }
  return out;
};

/** Erro tratado devolvendo valor-zero silencioso. */
const gerErroEngolido = (arquivos) => {
  const out = [];
  for (const a of arquivos) {
    for (let i = 0; i < a.add.length; i++) {
      const l = a.add[i];
      if (!/if\s+err\s*!=\s*nil|if\s+.*!\w+\.Valid/.test(l.text)) continue;
      const seguintes = a.add.slice(i + 1, i + 4).map((x) => x.text).join(" ");
      if (!/return\s+(0|""|nil|false|time\.Time\{\})/.test(seguintes)) continue;
      if (/%w|log\.|slog\.|logger/.test(seguintes)) continue;
      out.push(
        cand("errors", a.file,
          `Este caminho de erro devolve valor-zero sem wrap (\`%w\`) e sem log. O erro deveria propagar?`,
          [`${a.file}:${l.n}`, l.text.trim().slice(0, 90), seguintes.trim().slice(0, 90)],
          a.file, l.n),
      );
    }
  }
  return out;
};

/** Conversão numérica estreitando tipo sem checagem. */
const gerCastSemChecagem = (arquivos) => {
  const out = [];
  for (const a of arquivos) {
    for (const l of a.add) {
      const m = /\b(int8|int16|int32|uint8|uint16|uint32)\s*\(\s*([^)]{3,})\)/.exec(l.text);
      if (!m || /^\s*\/\//.test(l.text)) continue;
      if (!/[-+*]/.test(m[2])) continue; // só expressões calculadas
      out.push(
        cand("contracts", m[1],
          `Conversão para ${m[1]} de uma expressão calculada, sem checagem de faixa. O invariante que a torna segura é imposto pelo tipo?`,
          [`${a.file}:${l.n}`, l.text.trim().slice(0, 120)],
          a.file, l.n),
      );
    }
  }
  return out;
};

/** Símbolo novo cujo corpo já existe em outro lugar do repo. */
const gerDuplicacao = (root, arquivos, repo) => {
  const out = [];
  const novos = [];
  for (const a of arquivos) {
    for (const l of a.add) {
      const m = /^\s*(?:func|type)\s+(\w+)/.exec(l.text);
      if (m) novos.push({ nome: m[1], file: a.file, line: l.n });
    }
  }
  for (const s of novos) {
    const outros = repo
      .filter((r) => r.file !== s.file)
      .filter((r) => new RegExp(`\\b(func|type)\\s+${s.nome}\\b`).test(r.texto))
      .map((r) => r.file);
    if (!outros.length) continue;
    out.push(
      cand("behaviour", s.nome,
        `${s.nome} é definido aqui e também em ${outros[0]}. É duplicação que deveria ser compartilhada?`,
        [`novo em ${s.file}:${s.line}`, `também em: ${outros.slice(0, 3).join(", ")}`],
        s.file, s.line),
    );
  }
  return out;
};

/** Entrada nova em lista de rotas/prefixos — política de auth. */
const gerRota = (arquivos, repo) => {
  const out = [];
  for (const a of arquivos) {
    // Arquivo de teste é cheio de URL de fixture ("/api/v1/customers/42/fiado",
    // "/abc/", "/0/"). Eram 14 dos 49 candidatos e nenhum era uma rota.
    if (/_test\.\w+$/.test(a.file)) continue;
    for (const l of a.add) {
      const m = /"(\/[\w/{}.-]*)"/.exec(l.text);
      if (!m) continue;
      const rota = m[1];
      if (rota.length < 3) continue;
      // só contexto de REGISTRO de rota: chamada de mount/route/handle, ou
      // entrada numa lista de prefixos.
      const registro = /Route\(|Mount\w*\(|Handle\w*\(|Get\(|Post\(|Put\(|Delete\(|^\s*"/.test(l.text);
      if (!registro) continue;
      const contexto = repo.find((r) => r.file === a.file)?.texto ?? "";
      const vizinhas = [...contexto.matchAll(/"(\/[\w/{}.-]+)"/g)].map((x) => x[1]).filter((r) => r !== rota);
      const versionada = /^\/api\/v\d/.test(rota);
      const outrasVersionadas = vizinhas.filter((r) => /^\/api\/v\d/.test(r)).length;
      out.push(
        cand("auth", rota,
          `A rota/prefixo ${rota} foi adicionada. Ela está sob a mesma política de autenticação das rotas vizinhas?`,
          [`${a.file}:${l.n}`,
           vizinhas.length ? `vizinhas no mesmo arquivo: ${vizinhas.slice(0, 5).join(", ")}` : null,
           versionada && outrasVersionadas === 0 ? "é a ÚNICA versionada (/api/vN) entre as vizinhas" : null,
           rota.endsWith("/") ? "termina em barra: cobre um namespace inteiro, não uma rota específica" : null],
          a.file, l.n),
      );
    }
  }
  return out;
};

/** Variável de teste declarada e nunca comparada. */
const gerTesteSemAssercao = (arquivos) => {
  const out = [];
  for (const a of arquivos.filter((x) => /_test\.\w+$/.test(x.file))) {
    const texto = a.add.map((l) => l.text).join("\n");
    for (const l of a.add) {
      const m = /^\s*(?:var\s+)?(\w+)\s*(?::=|=)\s*[^=]/.exec(l.text);
      if (!m) continue;
      const nome = m[1];
      // Locais genéricas de teste produziam candidato sem conteúdo:
      // `cases` cinco vezes, `router`, `boom`, `issuer`, `suffix`.
      if (nome.length < 4) continue;
      if (/^(err|ctx|tt|tc|got|want|cases|tests|router|srv|server|req|res|rec|body|buf|handler|mux|now|ts|id|key|val)$/i.test(nome)) continue;
      const usos = (texto.match(new RegExp(`\\b${nome}\\b`, "g")) ?? []).length;
      const comparado = new RegExp(`(if|assert\\w*|Equal|!=|==)[^\\n]*\\b${nome}\\b|\\b${nome}\\b[^\\n]*(!=|==)`).test(texto);
      if (usos > 1 && comparado) continue;
      out.push(
        cand("tests", nome,
          `${nome} é declarado no teste e nunca aparece numa asserção. O teste assegura o que aparenta?`,
          [`${a.file}:${l.n}`, l.text.trim().slice(0, 110), `ocorrências no arquivo: ${usos}`],
          a.file, l.n),
      );
    }
  }
  return out;
};

/** Teste que pula sozinho — cobertura condicional a ambiente. */
const gerTestePulavel = (arquivos, repo) => {
  const out = [];
  for (const a of arquivos.filter((x) => /_test\.\w+$/.test(x.file))) {
    const chamadas = new Set();
    for (const l of a.add) {
      for (const m of l.text.matchAll(/(\w+)\.(\w+)\(/g)) chamadas.add(`${m[1]}.${m[2]}`);
    }
    for (const c of chamadas) {
      const [pkg, fn] = c.split(".");
      const def = repo.find((r) => new RegExp(`func\\s+${fn}\\b`).test(r.texto) && r.file.includes(pkg));
      if (!def || !/t\.Skip/.test(def.texto)) continue;
      out.push(
        cand("tests", c,
          `${c} pode chamar t.Skip. O que este teste cobre deixa de ser coberto quando ele pula?`,
          [`${a.file}`, `${def.file} contém t.Skip`],
          a.file, a.add[0]?.n ?? 1),
      );
    }
  }
  return out;
};

/** Ramo novo que nenhum teste parece exercitar. */
const gerRamoSemTeste = (arquivos, repo) => {
  const out = [];
  const testes = repo.filter((r) => /_test\.\w+$/.test(r.file)).map((r) => r.texto).join("\n");
  for (const a of arquivos.filter((x) => !/_test\.\w+$/.test(x.file))) {
    for (const l of a.add) {
      const m = /return\s+\w*[Ee]rror\w*\(|apperror\.New\(|http\.Status(\w+)/.exec(l.text);
      if (!m) continue;
      const codigo = /"(\w{4,})"/.exec(l.text)?.[1] ?? /http\.Status(\w+)/.exec(l.text)?.[1];
      if (!codigo) continue;
      if (testes.includes(codigo)) continue;
      out.push(
        cand("tests", codigo,
          `O ramo que produz ${codigo} foi adicionado e nenhum teste menciona esse código. Ele é alcançável e está coberto?`,
          [`${a.file}:${l.n}`, l.text.trim().slice(0, 110), `"${codigo}" não aparece em nenhum arquivo _test`],
          a.file, l.n),
      );
    }
  }
  return out;
};

/** Duas ou mais chamadas ao store na mesma função, sem transação. */
const gerSemTransacao = (arquivos) => {
  const out = [];
  for (const a of arquivos.filter((x) => !/_test\.\w+$/.test(x.file))) {
    const chamadas = a.add.filter((l) => /\bs\.store\.\w+\(|\bq\.\w+\(ctx|\.Query\w*\(/.test(l.text));
    if (chamadas.length < 2) continue;
    const texto = a.add.map((l) => l.text).join("\n");
    if (/\bTx\b|Begin\(|Transaction/.test(texto)) continue;
    out.push(
      cand("db", a.file,
        `${chamadas.length} chamadas ao banco na mesma operação, sem transação. Elas precisam de snapshot consistente?`,
        [`${a.file}`, ...chamadas.slice(0, 3).map((l) => `linha ${l.n}: ${l.text.trim().slice(0, 70)}`)],
        a.file, chamadas[0].n),
    );
  }
  return out;
};

/** Comentário que promete paridade com outra implementação. */
const gerParidade = (arquivos, repo) => {
  const out = [];
  for (const a of arquivos) {
    for (const l of a.add) {
      if (!/\/\/|--|#/.test(l.text)) continue;
      const m = /\b(parit|equivalent|mesma lógica|same as|espelha|mirror|desktop|migrat)\w*\b/i.exec(l.text);
      if (!m) continue;
      out.push(
        cand("behaviour", a.file,
          `Este comentário afirma paridade com outra implementação. As duas de fato concordam?`,
          [`${a.file}:${l.n}`, l.text.trim().slice(0, 140)],
          a.file, l.n),
      );
    }
  }
  return out;
};

/** Regras versionadas do repo viram decisões sobre o diff. */
const gerRegras = (root, arquivos) => {
  const regras = lerRegras(root);
  const tocados = arquivos.map((a) => a.file).filter((f) => CODE.test(f));
  if (!regras.length || !tocados.length) return [];
  return regras.slice(0, 40).map((r) =>
    cand("repo_rules", r.fonte,
      `O código novo viola esta regra do repositório? "${r.regra}"`,
      [`fonte: ${r.fonte}`, `arquivos tocados: ${tocados.slice(0, 5).join(", ")}`],
      r.fonte, 0),
  );
};

/* ------------------------------------------------------------- público --- */

/**
 * Gera o espaço de decisão para um diff.
 *
 * Tudo aqui é determinístico: git, leitura de arquivo e regex. Nenhuma LLM,
 * nenhuma chamada de rede. O custo é milissegundos.
 */
export const gerarDecisoes = (root, diff) => {
  seq = 0;
  const arquivos = parseDiff(diff);
  const repo = lerRepo(root);
  const todos = [
    ...gerSqlArtifact(root, arquivos),
    ...gerSqlSemFiltro(arquivos),
    ...gerRetornoDescartado(arquivos),
    ...gerErroEngolido(arquivos),
    ...gerCastSemChecagem(arquivos),
    ...gerDuplicacao(root, arquivos, repo),
    ...gerRota(arquivos, repo),
    ...gerTesteSemAssercao(arquivos),
    ...gerTestePulavel(arquivos, repo),
    ...gerRamoSemTeste(arquivos, repo),
    ...gerSemTransacao(arquivos),
    ...gerParidade(arquivos, repo),
    ...gerRegras(root, arquivos),
  ];
  // dedupe por (kind, subject, file, line)
  const vistos = new Set();
  return todos.filter((c) => {
    // A pergunta ENTRA na chave: sem isso, 22 regras do repo (mesmo kind,
    // mesmo subject, mesma linha 0) colapsavam em 2 candidatos.
    const k = `${c.kind}|${c.subject}|${c.file}|${c.line}|${c.question}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
};
