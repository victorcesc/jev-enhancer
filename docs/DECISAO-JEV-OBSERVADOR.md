# Decisão arquitetural — o Jev não elimina nada

**Status:** vigente
**Escopo:** todo o jev-enhancer

## A decisão

> O Jev **não pode eliminar candidato, achado ou evidência** no jev-enhancer.

Ele fica como **observador passivo**: pontua, e a pontuação é telemetria.

```
decision space
   ├───────────→ LLM          (caminho decisório)
   │
   └───────────→ Jev score    (só telemetria)
```

## Por quê — três medições independentes, mesmo erro

Não é calibragem. É o mesmo viés, na mesma direção, em três experimentos que
não compartilham código nem prompt: **o Jev subestima problema real com alta
confiança.**

| experimento | o que aconteceu |
| --- | --- |
| **A/B/C** | Rejeitou 2 achados em 3 execuções. Os **dois** eram defeitos reais verificados no código. Falsos positivos capturados: **zero** — nenhuma das 9 execuções alucinou, então não havia o que filtrar. |
| **E** | Confirmou uma alucinação (`assertAppError não está definida`) com `valid=0,83`, **acima** dos dois achados verdadeiros da mesma execução (0,56 e 0,62). A definição estava no diff que ele recebeu. Perguntado direto — "o símbolo aparece definido?" — respondeu certo, 0,75. Ele acerta o fato e erra a composição. |
| **F** | Marcou `safe` dois defeitos `med`, um deles (`error-discarded-no-wrap-no-log`) com risco **0,13**. É um defeito que o Opus encontra em praticamente toda execução. |

E a curva de troca do F é **monotônica** — não existe limiar que evite trabalho
sem custar defeito:

| política | trabalho evitado | defeitos retidos |
| --- | --- | --- |
| suspicious + uncertain | 54% | 15/27 |
| + safe com risco ≥ 0,4 | 51% | 16/27 |
| + safe com risco ≥ 0,2 | 43% | 16/27 |
| tudo menos `not_applicable` | 8% | 17/27 |
| sem triagem | 0% | **18/27** |

Procurar um limiar melhor a esta altura seria ajustar o experimento ao
resultado desejado.

## O que isso NÃO quer dizer

- **Não é que o Jev seja ruim em tudo.** Ele acertou uma remoção em campo: um
  achado que afirmava que `strconv.Atoi` trunca em vez de errar (é falso,
  verifiquei rodando). E responde bem pergunta factual estreita.
- **Não é abandono.** A telemetria continua sendo coletada. Se aparecer um
  regime onde ele erre para o lado seguro, os dados estarão lá.

## O que substituiu a função dele

Refutação **determinística** (`src/claims.mjs`): se um achado afirma que `X`
não existe e `X` está definido no repositório, o achado é falso por fato — com
arquivo e linha como prova, sem probabilidade e sem chamada de rede.

Estado: 2/2 alucinações conhecidas refutadas, 0 falsas refutações em 235
achados reais (`test/claims-refutacao.mjs`).

## Consequência de código

- `src/verify.mjs`: o único veredito que remove é `contradicted`, e ele exige
  evidência positiva. Dúvida vira `needs_context` e continua visível.
- `src/decide.mjs`: nenhum estado remove candidato. Quem decide o que a LLM
  investiga não é o Jev.
- Qualquer caminho novo que faça o Jev descartar algo precisa reverter esta
  decisão explicitamente, com medição que a contradiga.
