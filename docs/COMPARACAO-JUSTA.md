# Comparação justa — LLM fazendo review sozinha vs. com jev

As medições anteriores comparavam o agente **com jev** contra o agente **sem
jev que nunca foi instruído a revisar**. Isso não media qualidade de review:
media a existência de um gatilho. Este documento refaz o teste pedindo review
explicitamente nos dois braços.

## Desenho

Mesmo código (implementação de `GET /customers/{id}/fiado` gerada na rodada
`a06f367b`), mesmo repo, mesmo modelo (`claude-opus-5`).

| braço | como rodou |
| --- | --- |
| **sem jev** | sessão nova, `.claude/` e `.jev/` movidos para fora do repo, prompt pedindo code review do diff |
| **com jev** | sessão `a06f367b`, hook de Stop dispara, subagente roda o protocolo, Jev verifica |

O braço sem jev precisou ser isolado movendo os diretórios: `--settings` **não**
desativa o `.claude/settings.json` do projeto, e a primeira tentativa rodou com
o hook ativo (invalidada e descartada).

## Resultado — custo e tempo

| | sem jev | com jev | delta |
| --- | --- | --- | --- |
| tempo | 4,1 min | 4,5 min | **+10%** |
| tokens | 1.407.460 | 1.831.791 | **+30%** |
| custo (mesma tabela de preços) | 1,00× | 1,02× | **+2%** |
| turnos de análise | 26 | 26 (subagente) | **0** |

### Por que tokens sobem 30% e o custo sobe 2%

| | input | cache write | cache read | output |
| --- | --- | --- | --- | --- |
| sem jev | 52 | 63.214 | 1.324.210 | **19.984** |
| com jev | 58 | 85.432 | 1.738.936 | **7.365** |

O braço sem jev escreveu o relatório inteiro na conversa (19.984 tokens de
output); o braço com jev gravou em arquivo via subagente (7.365). Output custa
~50× mais que cache read, então o braço mais barato em volume é o mais caro por
token. **Em dinheiro, os dois empatam.**

### Onde vai o custo do braço com jev

| componente | turnos | tokens |
| --- | --- | --- |
| orquestração na sessão principal | 3 | 325.590 |
| subagente (a análise de verdade) | 26 | 1.506.201 |

Comparando **só a análise**: 1.506.201 (subagente) vs 1.407.460 (standalone) =
**+7%**. A análise custa praticamente o mesmo. Os outros 23% são o preço de o
gatilho viver *dentro* da sessão, onde cada turno recarrega ~108k de contexto
acumulado da implementação.

## Resultado — qualidade

**10 achados cada. Auditei os 20 à mão: 20/20 são defeitos reais. Precisão 1,00
nos dois braços.**

Mas encontraram coisas **diferentes**:

| defeito | com jev | sem jev |
| --- | --- | --- |
| sqlc não regenerado — `go build ./...` quebra (**high**) | ✓ | ✓ |
| teste de isolamento multi-tenant nunca exercitado (med) | ✓ | ✓ |
| `internalError` descarta erro: sem `%w`, sem log (med) | ✓ | ✓ |
| `numericFloat` engole erro e devolve 0 (med/low) | ✓ | ✓ |
| validade do `timestamptz` descartada (low) | ✓ | ✓ |
| contrato de erro divergente middleware vs handler (low) | ✓ | ✓ |
| subquery de `payments` sem predicado → agrega tabela inteira (**med**) | ✓ | — |
| ramo de fallback não-`AppError` sem cobertura (**med**) | ✓ | — |
| teste de contrato não desce em `pagination`; `items[0]` sem guard (low) | ✓ | — |
| summary e listagem em duas queries fora de transação (low) | ✓ | — |
| `Page.Offset`: conversão `int32` sem checagem, invariante burlável (low) | — | ✓ |
| `TestCustomerFiado_invalidParams`: asserção vazia (low) | — | ✓ |
| divergência de paridade com o desktop: `COALESCE` vs `IS NULL` (low) | — | ✓ |
| nomes de uma letra violam `.cursor/rules/RULES.md:56` (low) | — | ✓ |

**6 em comum, 4 exclusivos de cada lado, 14 defeitos distintos na união.**

> ⚠️ **O recall de 71% que este documento afirmava está errado** — ver
> `EXPERIMENTO-ABC.md`. Ele usava como denominador os 14 defeitos que estes
> dois reviews acharam, o que é circular: o denominador era a soma dos
> numeradores, então qualquer um dos dois dava ~71% por construção.
>
> Com teto de achados folgado (20 em vez de 10), execuções posteriores acharam
> **9 defeitos reais a mais**, todos verificados no código. Contra o conjunto
> atual de 23, cada um destes reviews fez **10/23 = 43%**, e a união dos dois,
> **14/23 = 61%**.
>
> A conclusão qualitativa — os dois empatam e acham coisas diferentes —
> **continua válida**. Os percentuais, não.

### A única diferença de qualidade que aparece

Os 4 exclusivos do braço com jev incluem **2 de severidade média**; os 4
exclusivos do braço sem jev são **todos low**. Distribuição final: com jev
1 high / 4 med / 5 low, sem jev 1 high / 3 med / 6 low.

É uma vantagem real mas estreita, de um único achado de severidade média, em
n=1. Não sustenta sozinha uma afirmação de superioridade.

### Verificações que confirmei no código

Os 4 exclusivos do braço sem jev eu esperava que fossem ruído. Não são:

- **`Page.Offset`** — `type Page struct { Number int; Limit int }` tem campos
  exportados e é construído direto em `fiado_router_test.go:100/150`; o
  invariante só existe dentro de `NewPage`.
- **asserção vazia** — `customerIDParam` faz `return 0, apperror.New(...)` em
  entrada inválida, então `if lister.gotCustomerID != 0` nunca falharia.
- **paridade com o desktop** — confirmado lendo os dois arquivos:
  `sale_repository.rs:198` usa `(p.total_paid IS NULL OR p.total_paid < s.total)`,
  `query/fiado.sql:38` usa `COALESCE(p.total_paid, 0) < s.total`. Para venda com
  `total <= 0` e sem pagamento, o desktop inclui e a API omite.
- **nomes de uma letra** — não é opinião de estilo: `.cursor/rules/RULES.md:56`
  proíbe explicitamente e **reserva `t` para `*testing.T`**, enquanto o código
  usa `t pgtype.Timestamptz`. É violação de regra versionada do repo.

## Conclusão

**Neste teste, a LLM sozinha revisou tão bem quanto com a ferramenta, pelo mesmo
dinheiro e em tempo parecido.** A qualidade do review vem do modelo, não do
Jev.

Isso corrige a leitura anterior. A tabela do `AUDITORIA-QUALIDADE.md` que diz
"sem jev: 0 de 10 bugs" está correta como fato e **enganosa como comparação**:
aquele agente não foi reprovado num review, ele nunca recebeu um pedido de
review. O que aquela medição mostrou foi que **um agente deixado por conta
própria não revisa o próprio trabalho** — rodou um único `go vet` num pacote que
nem era o dele e declarou concluído.

### O que a ferramenta entrega, então

Não é review melhor. É:

1. **O gatilho.** O review acontece sem ninguém pedir, no momento em que o
   agente ia declarar pronto. Esse é o valor medido e ele é real — sem o hook,
   o review simplesmente não aconteceu.
2. **Verificação calibrada.** Nesta rodada o Jev confirmou 10/10 e rejeitou 0,
   então **não contribuiu nada de mensurável aqui**. O valor dele foi
   demonstrado no teste de estresse (rejeitou 7 de 8 alucinações plantadas sem
   perder nenhum achado real), não em campo. Os dois braços produziram zero
   alucinações, então a camada não foi exercitada.
3. **Contexto fresco.** Rodar no subagente evita poluir a sessão principal — é
   o que mantém a orquestração em 3 turnos.

### O que isso custa

**325.590 tokens (+23%)** para que o review dispare sozinho dentro da sessão,
já que a análise em si custa o mesmo dos dois jeitos. Em dinheiro, o custo
total empata.

## Próximo experimento óbvio

Um terceiro braço: **hook que só injeta "faça code review do diff", sem
contexto preparado, sem protocolo, sem verificação.** Se ele achar os mesmos ~10
defeitos, então a máquina toda (`prepare`, `review-context.md`,
`review-prompt.md`, `verify`) não está pagando por si, e o produto se reduz a um
hook de três linhas.

Os dados atuais **não descartam essa hipótese** — pelo contrário, apontam para
ela: o contexto preparado (51.870 chars) não reduziu a investigação do
subagente, que gastou os mesmos 26 turnos que a sessão standalone sem nenhum
contexto preparado.

## Ressalvas

- **n=1 por braço**, uma tarefa, um repo, um modelo. A diferença de 1 achado
  med está dentro do ruído esperado.
- A união de 14 defeitos **não é ground truth**: é a união do que dois reviews
  acharam. O denominador real é desconhecido — e de fato subiu para 23 quando
  mais execuções rodaram (ver `EXPERIMENTO-ABC.md`), então o recall citado era
  um limite superior bem otimista dos dois lados.
- O braço sem jev rodou em **contexto limpo**; o com jev rodou dentro de uma
  sessão com a implementação acumulada. Isso favorece o braço sem jev na conta
  de tokens (é a origem dos 325k de orquestração) e é, ao mesmo tempo, a
  condição real de operação do produto. Ambas as leituras estão na tabela.
- O repo de teste (`pdv`) **não tem CI nem git hooks**, então o achado de build
  quebrado é mais dramático aqui do que seria num repo com gates.
