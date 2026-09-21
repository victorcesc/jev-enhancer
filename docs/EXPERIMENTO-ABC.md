# Experimento A/B/C — o pipeline paga por si?

9 execuções (3 por braço) sobre o mesmo snapshot congelado, mesmo modelo
(`claude-opus-5`), pontuadas contra um known defect set de 23 defeitos que eu
verifiquei um a um no código.

| braço | o que é |
| --- | --- |
| **A** | usuário pede o review no prompt; sem hook, sem pipeline |
| **B** | jev-enhancer completo: gate → contexto preparado → subagente → Jev Verify |
| **C** | minimal trigger: hook injeta **o mesmo texto do braço A**, nada mais |

Critério definido antes de rodar: *se `C ≈ B`, as partes do pipeline sem ganho
demonstrado saem.*

## Resultado

| braço | achados | recall | tokens | tempo |
| --- | --- | --- | --- | --- |
| A | 10,0 (9–11) | 41% (35–43%) | 1.805.478 | 293s |
| **B** | **12,0 (10–14)** | **52% (43–61%)** | 1.906.151 | 311s |
| C | 8,3 (6–10) | 32% (22–39%) | 1.326.599 | 185s |

Par a par, contando separação só quando as faixas não se tocam:

```
A ~ B   empate — 35%–43% vs 43%–61%
A ~ C   empate — 35%–43% vs 22%–39%
B > C   SEPARADO — pior caso de B (43%) supera o melhor de C (39%)
```

**O critério não se aplica: `C` não empata com `B`.** O pipeline compra recall.

## A comparação que decide, pareada por custo

Comparar 1 execução de B com 1 de C é injusto — B custa mais. Pareando custo:

| configuração | recall | tokens | defeitos por milhão de tokens |
| --- | --- | --- | --- |
| 1× C | 32% | 1.326.599 | 5,5 |
| 1× A | 41% | 1.805.478 | 5,2 |
| **1× B** | **52%** | **1.906.151** | **6,3** |
| 2× C | 46% | 2.653.197 | 4,0 |
| 2× A | 58% | 3.610.955 | 3,7 |
| 2× B | 68% | 3.812.302 | 4,1 |
| 3× C | 57% | 3.979.796 | 3,3 |
| 3× A | 70% | 5.416.433 | 3,0 |
| 3× B | 78% | 5.718.453 | 3,1 |

**1× B domina 2× C**: mais recall (52% vs 46%) com menos tokens (1,91M vs
2,65M). Gastar o orçamento no pipeline rende mais do que gastar em rodar o
review simples duas vezes.

`1× B` é também a configuração mais eficiente da tabela. Toda adição de worker
piora a eficiência (6,3 → 4,1 → 3,1), então diversidade funciona mas com
retorno decrescente claro.

## O achado que eu não esperava: C perde para A com o MESMO texto

`A` e `C` recebem **instrução idêntica**, palavra por palavra. A única
diferença é como ela chega: em `A` é o prompt do usuário; em `C` é o `reason`
de um Stop hook, depois de uma tarefa trivial.

`A` fica em 41% e `C` em 32%.

A conclusão prática é que **o minimal trigger não é equivalente a pedir**. O
agente trata o bloqueio injetado como interrupção a ser resolvida rápido, não
como o trabalho principal da sessão. Isso desfaz a premissa do braço C: "só o
gatilho" não entrega o mesmo review, mesmo com o mesmo pedido.

É também a explicação mais provável para por que o pipeline ajuda. Ele não
melhora o raciocínio — ele reconstitui, via contexto preparado e protocolo em
subagente, o enquadramento de "isto é a tarefa" que o hook sozinho destrói.

## Resultado negativo: o Jev Verify cortou defeitos reais

Medido nas 3 execuções de B, com chamadas reais (`mode=jev`, não mock):

| execução | achados antes → depois | veredictos | o que foi rejeitado |
| --- | --- | --- | --- |
| b-1 | 14 → 13 | confirmed 12, needs_context 1, rejected 1 | `unauth-branch-unreachable` |
| b-2 | 10 → 9 | confirmed 8, needs_context 1, rejected 1 | `boundary-cases-untested` |
| b-3 | 12 → 12 | confirmed 12 | — |

**2 rejeições, 2 defeitos reais destruídos, 0 falsos positivos capturados.**

Os dois rejeitados estão no known set porque eu os verifiquei no código antes
de saber que o Jev os havia rejeitado.

Isto contraria o teste de estresse anterior (7 de 8 alucinações plantadas
rejeitadas, nenhum verdadeiro perdido). A diferença explica os dois
resultados: **lá existiam falsos grosseiros para pegar; aqui não havia falso
nenhum.** Nenhuma das 9 execuções alucinou. O verificador foi otimizado para
um cenário que não se materializou, e o único efeito mensurável em campo foi
dano.

Recomendação: **desligar a rejeição por padrão.** Rebaixar `rejected` para
`needs_context` preserva o sinal para o revisor humano sem apagar o achado. O
`VALID_FLOOR` foi calibrado contra alucinações plantadas, não contra achados
de campo.

## O known defect set cresceu 64% durante a medição

14 → 17 → 18 → 20 → 22 → 23. Nove execuções, e defeitos inéditos ainda
entraram na última.

| execução | achou | inéditos |
| --- | --- | --- |
| b-1 | 14 | 14 |
| c-1 | 8 | 1 |
| a-2 | 10 | 2 |
| b-2 | 10 | 2 |
| c-2 | 9 | 2 |
| a-3 | 8 | 0 |
| b-3 | 12 | 0 |
| c-3 | 5 | 0 |
| a-1 | 10 | 1 |

A curva achatou perto do fim, mas só depois de ~8 execuções. **Nenhum review
individual chega perto de cobrir o espaço**: cada um acha ~10 defeitos, e
são 10 *diferentes*.

Isso invalida os números de `COMPARACAO-JUSTA.md`, que mediam recall contra um
denominador de 14. Aquele documento foi corrigido.

## Ressalvas

- **n=3 por braço.** `A ~ B` é empate de faixas, não equivalência provada. A
  variância dentro de B (43%–61%) é maior que a distância entre A e B.
- **A análise de diversidade não é evidência independente**: usa as mesmas 9
  execuções que produziram o known set.
- **Limitações uniformes entre braços**, que deprimem o recall absoluto de
  todos: `go test` negado pela allowlist, comandos compostos (`cd X && ...`)
  negados por casamento de prefixo, e permissões de `Write` corrigidas no meio
  do lote (o `score.py` marca as execuções com custo inflado).
- **Um repo, uma feature, um modelo.**

## O que fazer com isso

1. **Manter o pipeline.** O critério de simplificação não foi atingido: B
   domina C em recall e em tokens simultaneamente.
2. **Desligar a rejeição do Jev Verify**, rebaixando para `needs_context`. É a
   única mudança que os dados sustentam sozinha, e é uma mudança pequena.
3. **Não adicionar workers ainda.** O retorno existe (+3,3 a +4,0 defeitos no
   segundo worker) mas a eficiência cai pela metade. `1× B` é o melhor ponto
   da curva medida.
4. **Investigar o enquadramento do hook.** Se `C` perde para `A` com texto
   idêntico, há recall sendo perdido no *modo de entrega*, e isso afeta `B`
   também — que é entregue pelo mesmo hook.
