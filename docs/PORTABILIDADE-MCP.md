= Portabilidade: MCP como tool call (discussão, não implementado)

Ideia: expor o jev-enhancer como servidor MCP para facilitar uso em Codex,
Cursor, xAI e outros, em vez de um adapter por harness.

## O que MCP resolve bem

As peças determinísticas são funções puras e encaixam perfeitamente:

- `jev_prepare` → cost gate + contexto (git + AST, sem LLM)
- `jev_verify` → triagem Jev (HTTP barato, sem LLM)

Qualquer harness com MCP chamaria as duas sem adapter próprio. O servidor
seria pequeno — o código já existe, seria um wrapper.

## O que MCP NÃO resolve

**1. O disparo automático.** O requisito central é "zero invocação explícita",
mas uma tool só roda se o agente decidir chamá-la. Quem garante o disparo é o
hook de conclusão, e isso é específico de cada harness:

| harness | mecanismo |
| --- | --- |
| Claude Code | Stop hook ✓ |
| Codex | `hooks.json` ✓ |
| Cursor | regras/MCP — sem hook de conclusão claro |
| xAI | a verificar |

**2. A análise em contexto fresco.** O review precisa de LLM, e medimos que
rodá-la no contexto principal é caro. Quem resolve isso hoje é o subagente do
harness. Um servidor MCP não cria subagente; e se chamasse a API por conta
própria, quebraria o princípio "o harness é dono da LLM" e exigiria chave.

Ou seja, `jev_review` como tool esbarra em: quem faz a análise? Se for o agente
principal, voltamos à orquestração cara que acabamos de eliminar.

## Alerta dos nossos próprios dados

No estudo do `jev-context`, o servidor MCP de navegação foi REPROVADO: as
respostas das tools entravam no contexto e eram re-cobradas a cada turno.
Aqui seria diferente (1-2 chamadas, não dezenas), mas a regra vale:
**tool dentro do loop custa; tool fora do loop é grátis.**

`jev_verify` chamado pelo subagente está fora. `jev_review` chamado pelo agente
principal estaria dentro.

## Recomendação

Híbrido, nesta ordem:

1. expor `jev_prepare` e `jev_verify` via MCP — as peças realmente portáveis;
2. manter o gatilho por hook, específico de cada harness (irredutível);
3. manter a análise no subagente do próprio harness (irredutível, e é o que
   mantém o custo baixo).

Assim o adapter de cada harness vira poucas linhas: *"no evento de conclusão,
mande o agente chamar `jev_prepare`, rodar os passes em subagente e chamar
`jev_verify`"*.

## Sobre o timing

Fazer **um segundo adapter antes** (Codex, que tem `hooks.json` e é o mais
próximo) e só então generalizar. Até termos dois adapters funcionando não
sabemos qual é a abstração certa — e já erramos assim uma vez nesta pesquisa,
quando as ferramentas de navegação pareciam a abstração óbvia e os dados
reprovaram.
