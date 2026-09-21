# Experimento A/B/C — o pipeline paga por si?

Testa se as partes caras do jev-enhancer (contexto preparado, protocolo,
Jev Verify) melhoram o review em relação a simplesmente **pedir** um review.

| braço | o que é | gatilho | pipeline |
| --- | --- | --- | --- |
| **A** | review explícito standalone | usuário pede no prompt | nenhum |
| **B** | jev-enhancer completo | Stop hook | gate → contexto → subagente → Jev Verify |
| **C** | minimal trigger | Stop hook | **nenhum** — injeta o mesmo texto do braço A |

**Critério (definido antes de rodar):** se `C ≈ B` em recall e achados reais,
as partes do pipeline que não demonstrarem ganho saem. Complexidade não se
preserva sem evidência.

`A ≈ C` é a checagem de sanidade: se divergirem muito, o problema é o
mecanismo de entrega, não o pipeline, e a comparação `C vs B` não vale.

## Como rodar

```sh
ANTHROPIC_API_KEY=... ./run-all.sh 3     # 3 repetições de cada braço
python3 score.py --matrix                 # matriz defeito × braço
python3 score.py --diversity              # recall da união de k workers
python3 score.py runs/b-2                 # detalhe de uma execução
```

`run-all.sh` é sequencial de propósito: o harness restaura o snapshot antes de
cada execução, então duas sessões simultâneas no mesmo repo se atropelam.

## Controles

**Snapshot congelado.** `snapshot.tar.gz` tem os 15 arquivos da feature sobre
o commit `4ae137b`. Cada execução restaura o repo antes de começar, então os
três braços revisam byte a byte o mesmo código. Verificado: o
`review-context.md` gerado tem 51.870 chars, idêntico ao da execução original.

**Permissões.** `perms.json` é uma allowlist somente-leitura, com escrita
liberada só no arquivo de achados e `rm`/`git checkout`/`git reset`/`make`/
`sqlc` explicitamente negados — o review não pode consertar nada nem mascarar
o defeito de build. O workspace precisa estar confiado (`hasTrustDialogAccepted`),
senão o CLI **ignora a allowlist inteira** e cai em "Not logged in".

**Mesmo modelo** (`claude-opus-5`) e mesmo prompt trivial para B e C.

## Confound encontrado antes de rodar

O protocolo do braço B dizia **"Máximo 10 achados"**. Os dois reviews-piloto
pararam exatamente em 10. Com o teto em 10 é impossível distinguir "achou 10"
de "foi cortado em 10" — e toda a leitura de recall da comparação anterior
dependia disso.

Teto subiu para 20 (`review.max_findings`, default em `prepare.mjs`), e o
prompt dos braços A e C usa o mesmo 20. **A união de 14 defeitos é um piso,
não um teto.**

## Isolamento novo em relação à medição anterior

Antes, o braço B revisava dentro da sessão que acabara de implementar a
feature, e pagava 325.590 tokens só de contexto acumulado na orquestração.
Aqui, B e C partem de um prompt trivial, então a orquestração é barata nos
dois. Isso isola **o pipeline**, que é a pergunta em jogo.

O custo real do produto em operação continua sendo o medido em
`docs/COMPARACAO-JUSTA.md`; este experimento mede outra coisa.

## Known defect set

`known-defects.yaml` — 14 defeitos, cada um verificado por mim no código.

**Não é ground truth absoluta.** É a união de dois reviews que estavam ambos
limitados a 10 achados. Achado novo que a auditoria confirmar entra no
conjunto e `known_total` sobe.

O `score.py` casa achado com defeito por palavra-chave e **nunca descarta o
que não casou** — imprime como `NÃO CASOU`, que é a fila de auditoria manual:
ou é defeito novo, ou é falso positivo.

### Estado atual (só os dois pilotos, n=1, teto 10)

| | A | B |
| --- | --- | --- |
| achados | 10 | 10 |
| known encontrados | 10/14 | 10/14 |
| recall | 71% | 71% |
| recall ponderado por severidade | **71%** | **81%** |

A diferença só aparece na ponderação: os 4 exclusivos de B incluem 2 `med`;
os 4 exclusivos de A são todos `low`.

O `a + b = 100%` que o `--diversity` imprime é **circular** — essas duas
execuções definiram o conjunto. O script marca isso sozinho.

## Experimento B (Review Diversity) sai de graça

Unir k execuções do mesmo braço é exatamente o que k workers paralelos
produziriam. Com 3 repetições dá para medir o retorno marginal do 2º e do 3º
worker sem nenhuma execução extra — é o que `--diversity` calcula.

Só vale a pena rodar workers especializados (Experimento C) depois de ver se
workers idênticos já pagam.

## Limitações descobertas durante a execução

Registradas aqui porque afetam a leitura dos números, e todas incidem
igualmente nos três braços — deprimem o recall absoluto, não a comparação.

**`go test` negado.** A allowlist tem `go build` e `go vet`, não `go test`.
Nenhum braço conseguiu rodar a suíte. Efeito prático pequeno (o código não
compila, então o teste falharia), mas custa turnos. Não corrigi no meio do
lote: mudar permissão entre execuções cria mais inconsistência do que o ganho.

**Comandos compostos negados.** Regras de permissão casam por prefixo, então
`cd X && sed ...` não casa com `Bash(sed:*)`. Todos os braços perderam turnos
nisso. `Read`/`Grep` estavam liberados como alternativa.

**Permissões mudaram no meio do lote.** `Write(.jev-exp/**)` não casava com o
caminho absoluto nesta versão do CLI (trust estava ok, stderr limpo). Corrigi
invertendo a lógica — `Write` liberado, arquivos de código no `deny` — a
partir de `b-2`. Execuções anteriores têm custo inflado por tentativas
negadas; o `score.py` marca quais. **O recall não é afetado**: os achados
foram capturados pelo fallback de JSON na resposta.

**Andaime do experimento dentro do review.** Até `a-2`, `.claude/` aparecia
como não versionado e `a-2` chegou a reportá-lo como defeito. Agora está em
`.git/info/exclude`.

**O known set cresceu durante a medição**, de 14 para 22. Recall de uma
execução antiga contra o denominador final é justo (ela teve a mesma chance),
mas qualquer número citado antes do fim do lote está defasado.

## Pendente

Nenhuma execução real rodou: falta `ANTHROPIC_API_KEY` no ambiente. Todo o
resto está validado sem gastar chamada — hook do braço C bloqueia uma vez e o
guard silencia na segunda; hook do braço B passa o gate (12 arquivos
relevantes, 1.276 linhas) e gera contexto e prompt corretos.
