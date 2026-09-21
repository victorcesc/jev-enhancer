// Refutação determinística de achados que afirmam inexistência.
//
// Origem: no experimento E, o Haiku alucinou "a função assertAppError não está
// definida, os testes não compilam" e o Jev CONFIRMOU com valid=0.83 — com a
// definição `func assertAppError(...)` dentro do diff que ele recebeu.
// Perguntado direto ("o símbolo aparece definido?") ele acertava: 0.75. Ele
// erra a COMPOSIÇÃO, não o fato.
//
// Então a composição sai do modelo e vira código: se o achado afirma que algo
// não existe, procuramos a DEFINIÇÃO. Achou, o achado está factualmente
// refutado — sem probabilidade, com arquivo e linha como prova.
//
// REGRA DE SEGURANÇA: ausência nunca refuta. Não achar a definição não vira
// evidência de nada. Se fosse o contrário, o defeito mais grave que este
// projeto já encontrou (`sqlc não regenerado`, cuja premissa é exatamente que
// símbolos não existem) seria apagado por esta função.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SKIP = new Set([".git", "node_modules", ".jev", ".jev-exp", ".claude", "vendor", "dist", "build", "target"]);
const CODE = /\.(go|rs|ts|tsx|js|mjs|py|gd|sql|java|rb|kt|swift|c|h|cpp)$/;
const MAX_FILES = 4000;

/**
 * Negações que são sobre EXISTÊNCIA, e só isso.
 *
 * A primeira versão desta regex aceitava `não é <qualquer coisa>`, e com isso
 * "o ramo nunca é exercitado" e "não há %w nem log" passavam por afirmações de
 * inexistência. Resultado: 49 dos 50 achados reais foram refutados, incluindo
 * o defeito mais grave do projeto. Daí a estreiteza deliberada aqui.
 */
const NEGACOES = [
  /(?:n[aã]o)\s+(?:est[aá]|foi|[eé]|s[aã]o|est[aã]o)\s+(?:definid\w*|declarad\w*|implementad\w*|criad\w*)/gi,
  /(?:n[aã]o)\s+(?:existe|existem|cont[eé]m)\b/gi,
  /\bem lugar nenhum\b/gi,
  // Sem exigir cópula: "stubUserLookup type not defined" escapava do padrão
  // `is/are not defined` e a alucinação passava. Modelo fraco escreve
  // telegráfico, então a regex não pode depender de frase bem formada.
  /\bnot\s+(?:defined|declared|implemented|present)\b/gi,
  /\bdoes\s+not\s+exist\b/gi,
  /\bnever\s+(?:defined|declared)\b/gi,
  /\b(?:n[aã]o\s+)?(?:definid[oa]|declarad[oa])\s+em\s+lugar\s+nenhum\b/gi,
];

/** O achado afirma que alguma coisa NÃO existe? */
export const afirmaInexistencia = (texto) =>
  NEGACOES.some((re) => {
    re.lastIndex = 0;
    return re.test(texto ?? "");
  });

const JANELA = 70; // chars ao redor da negação onde o sujeito pode estar

const limpaIdent = (s) => String(s ?? "").trim().split(/[.:(\s]/).pop();

/**
 * Identificadores que são SUJEITO de uma negação de existência.
 *
 * Não basta o identificador aparecer no achado: ele tem que estar colado à
 * negação. "`PendingStore` :: não existe internal/db/fiado.sql.go" fala de um
 * ARQUIVO ausente, não do símbolo — e o símbolo existe. Confundir os dois foi
 * o que quebrou a primeira versão.
 *
 * Caminhos de arquivo são descartados de propósito: arquivo ausente é
 * exatamente a premissa do defeito `sqlc não regenerado`, que precisa
 * sobreviver a esta checagem.
 */
export const simbolosNegados = (finding) => {
  // Só o texto do achado. O campo `symbol` é a LOCALIZAÇÃO do defeito, nunca o
  // sujeito da negação: em "PendingStore :: não existe internal/db/fiado.sql.go"
  // o símbolo existe e o arquivo é que falta. Incluí-lo aqui refutava o defeito
  // do sqlc em 7 execuções.
  const texto = String(finding.issue ?? "");

  // Tokens MAXIMAIS com posição. Fatiar o texto numa janela cortava
  // identificador no meio: `...UserIDAndIDParams` virava `IDAndID`, que por
  // acaso existia em outro arquivo e refutava o achado do sqlc.
  const tokens = [...texto.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)].map((m) => ({
    bruto: m[0],
    ini: m.index,
    fim: m.index + m[0].length,
  }));

  const negacoes = [];
  for (const re of NEGACOES) {
    re.lastIndex = 0;
    for (const m of texto.matchAll(re)) {
      // Guarda de ESCOPO. "internal/db não contém X" afirma ausência DENTRO de
      // um pacote; procurar X no repositório inteiro responde outra pergunta.
      // Sem isto, o defeito do sqlc era refutado por um stub de teste que
      // define o mesmo nome fora de internal/db.
      const antes = texto.slice(Math.max(0, m.index - 30), m.index);
      if (/[\w.-]+\/[\w./-]+\s*$/.test(antes)) continue;
      negacoes.push({ ini: m.index, fim: m.index + m[0].length });
    }
  }
  if (negacoes.length === 0) return [];

  // ADJACÊNCIA, não proximidade. A versão com janela de ±70 chars pegava
  // identificadores da oração anterior: em "…GetCustomerByUserIDAndID
  // retornando db.Customer…, pois não existe nenhuma outra query", o sujeito
  // da negação é "nenhuma outra query", e mesmo assim três símbolos entravam.
  // Agora só o token imediatamente antes e o imediatamente depois.
  const RUIDO = /^(a|o|as|os|um|uma|the|of|de|da|do|que|e|em|no|na)$/i;
  const aceita = (bruto) => {
    if (!bruto) return null;
    if (/[/\\]|\.(go|rs|ts|js|py|sql|mjs|tsx)$/i.test(bruto)) return null; // caminho
    const nome = limpaIdent(bruto);
    // CamelCase real: exclui palavra comum, quantificador ("nenhuma"), SQL em
    // caixa alta (LIMIT, OFFSET) e fragmento curto.
    if (nome.length < 5) return null;
    if (!/[a-z]/.test(nome) || !/[A-Z]/.test(nome)) return null;
    return nome;
  };

  // Varre até 3 tokens de cada lado, não apenas o vizinho imediato: em
  // "stubUserLookup type not defined" a palavra `type` fica entre o sujeito e
  // a negação, e olhar só um token deixava a alucinação passar. Os 3 tokens
  // continuam limitados por distância, então não vira a janela larga que
  // falhou antes.
  const VIZINHOS = 3;
  const out = new Set();
  for (const n of negacoes) {
    const antes = tokens.filter((t) => t.fim <= n.ini).slice(-VIZINHOS).reverse();
    const depois = tokens.filter((t) => t.ini >= n.fim).slice(0, VIZINHOS);
    for (const t of [...antes, ...depois]) {
      const dist = t.fim <= n.ini ? n.ini - t.fim : t.ini - n.fim;
      if (dist > 30) continue;
      const nome = aceita(t.bruto);
      if (nome) out.add(nome);
    }
  }
  return [...out];
};

/**
 * Padrões de DEFINIÇÃO, não de menção. A diferença importa: `db.GetXParams`
 * aparece citado no achado do sqlc, mas nunca definido — e é por isso que
 * aquele achado sobrevive a esta checagem, como tem de ser.
 */
const definicao = (sym) => {
  const s = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    [
      `\\b(func|function|def|fn|type|class|struct|interface|enum|trait|impl|const|var|let)\\s+${s}\\b`,
      `\\bfunc\\s*\\([^)]*\\)\\s*${s}\\b`, // método Go com receiver
      `\\b${s}\\s*(:=|=\\s*(function|async|\\(|\\{))`,
      `--\\s*name:\\s*${s}\\b`, // sqlc
      `\\b${s}\\s*\\([^)]*\\)\\s*\\{`, // definição estilo C/Java
    ].join("|"),
  );
};

const arquivos = function* (dir, depth = 0) {
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
    if (st.isDirectory()) yield* arquivos(full, depth + 1);
    else if (CODE.test(nome) && st.size < 2_000_000) yield full;
  }
};

/**
 * Procura a definição de `sym` no repositório. Devolve { file, line, trecho }
 * ou null. Determinístico, sem rede, sem modelo.
 */
export const achaDefinicao = (root, sym) => {
  const re = definicao(sym);
  let vistos = 0;
  for (const file of arquivos(root)) {
    if (++vistos > MAX_FILES) break;
    let texto;
    try {
      texto = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!texto.includes(sym)) continue; // filtro barato antes do regex
    const linhas = texto.split("\n");
    for (let i = 0; i < linhas.length; i++) {
      if (re.test(linhas[i])) {
        return { file: path.relative(root, file), line: i + 1, trecho: linhas[i].trim().slice(0, 160) };
      }
    }
  }
  return null;
};

/**
 * O achado afirma inexistência de algo que EXISTE?
 *
 * Devolve a prova ({symbol, file, line, trecho}) ou null. `null` significa
 * "não refutado", nunca "é falso".
 */
export const refutaInexistencia = (finding, root) => {
  const texto = `${finding.symbol ?? ""} — ${finding.issue ?? ""}`;
  if (!afirmaInexistencia(texto)) return null;
  for (const sym of simbolosNegados(finding)) {
    const achado = achaDefinicao(root, sym);
    if (achado) return { symbol: sym, ...achado };
  }
  return null;
};
