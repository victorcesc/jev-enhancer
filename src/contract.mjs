// Textos que o agente principal lê. Fonte única: o contrato do início da
// sessão, a instrução do `jev review` e o bloqueio de fallback do Stop
// precisam concordar entre si, e já divergiram quando viviam em dois lugares.
//
// Princípio de tamanho: o agente PRINCIPAL só precisa saber que o review é
// obrigatório e como disparar. O protocolo completo da análise vive em
// `.jev/review-prompt.md` e é lido pelo SUBAGENTE — cada caractere no contexto
// principal é re-cobrado a cada turno.
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Como o agente deve invocar o CLI. Se `jev` não estiver no PATH (instalação
 * local, sem npm link), emitimos o caminho absoluto — senão a instrução manda
 * rodar um comando que não existe e o protocolo quebra no primeiro passo.
 */
export const jevCommand = () => {
  const onPath = spawnSync("sh", ["-c", "command -v jev"], { encoding: "utf8", timeout: 5000 });
  if (onPath.status === 0 && (onPath.stdout ?? "").trim()) return "jev";
  const here = path.dirname(new URL(import.meta.url).pathname);
  return `node ${path.resolve(here, "cli.mjs")}`;
};

/**
 * Contrato instalado no INÍCIO da sessão (Etapa 3 do roteiro).
 *
 * Medido no experimento A/B/C: a mesma instrução de review entregue como
 * prompt do usuário rendeu 41% de recall, e entregue como bloqueio de Stop
 * rendeu 32%. A hipótese é que o agente trata o bloqueio como interrupção a
 * despachar, não como a tarefa. Este texto tenta mover o review para dentro
 * da definição de pronto, antes de a tarefa começar.
 */
export const doneContract = (cmd = "jev") =>
  `Antes de considerar concluída qualquer tarefa de implementação neste
repositório, execute \`${cmd} review\`.

A review faz parte da Definition of Done — não é uma etapa opcional nem uma
verificação posterior. Só finalize depois de receber e apresentar o resultado
dela.`;

/**
 * O que fazer quando o review é disparado. Uma ida e uma volta: lançar o
 * subagente e apresentar. Orquestrar etapa por etapa na sessão principal
 * custava 98% do total, porque cada turno relê todo o contexto acumulado.
 */
export const reviewInstruction = (promptFile, cwd = process.cwd()) => {
  const rel = path.relative(cwd, promptFile);
  return `Review do jev-enhancer.

Lance **UM ÚNICO subagente** com contexto limpo e passe a ele, como prompt, o
conteúdo de \`${rel}\`. Esse arquivo tem o protocolo completo — o subagente
executa tudo sozinho e devolve um JSON compacto.

Quando ele responder, **apresente os achados** no seu resumo final, ordenados
por severidade.

Duas regras:
- NÃO orquestre etapa por etapa nesta sessão: cada turno seu aqui relê todo o
  contexto acumulado. O subagente faz o trabalho barato.
- NÃO corrija nada. Este review é somente leitura — quem decide o que mudar é
  o usuário. Se algum achado parecer falso positivo, diga isso em vez de
  omiti-lo.`;
};

/**
 * Bloqueio de fallback do Stop (Etapa 4): o agente tentou finalizar sem ter
 * rodado o review. Curto de propósito — a instrução completa vem do
 * `jev review`, que ele vai executar em seguida.
 */
export const fallbackBlock = (cmd = "jev") =>
  `A tarefa ainda não está concluída: a review faz parte da Definition of Done
e ainda não foi executada nesta sessão.

Execute \`${cmd} review\` e siga a instrução que ele devolver, antes de
finalizar.`;
