# jev-enhancer

Code review **agent-driven**: o seu harness continua dono da LLM; o
jev-enhancer é dono do protocolo de review.

Depois de instalar, você esquece que ele existe. Trabalha normalmente com o
agente e o review entra sozinho, antes da conclusão.

```bash
jev init            # cria .jev/config.yaml neste repositório
jev apply claude    # instala o adapter (+ self-test)
# ...e pronto. Nenhuma invocação manual no dia a dia.
```

## Como funciona

```
agente diz "terminei"
   ↓
session guard ──── já revisou? → sai em silêncio
   ↓
cost gate ──────── diff pequeno/sem código? → registra e sai
   ↓
prepare ────────── diff + invariantes do repo + checks determinísticos
   ↓
bloqueia UMA vez com a instrução do protocolo
   ↓
agente roda os passes em SUBAGENTES (contexto limpo)
   ├── correctness
   └── tests
   ↓
jev verify ─────── triagem: valid / severity / evidence_sufficient
   ↓
agente APRESENTA os achados (não corrige nada)
   ↓
agente para de novo → guard silencia → fim
```

### Por que cada peça existe

- **Cost gate** — um review custa tokens de verdade. Sem gate, um ajuste de uma
  linha pagaria o mesmo que uma feature inteira, e a economia evapora.
- **Subagentes** — rodar os passes dentro da sessão de implementação faria cada
  turno re-cobrar as centenas de milhares de tokens já acumulados. Contexto
  limpo é o que mantém o review barato.
- **Bloqueio único + session guard** — o hook de Stop só consegue entregar a
  informação bloqueando; sem a guarda (e sem o limite defensivo de execuções),
  isso vira loop.
- **Jev fora do loop da LLM** — a triagem é uma chamada tipada e barata, feita
  fora do contexto do agente. Colocar o verificador *dentro* do loop custa caro
  e não melhora o resultado.
- **Read-only** — no MVP nada é corrigido automaticamente. Quem decide o que
  mudar é você.

## Princípios

1. Zero invocação explícita depois de instalado.
2. O harness é dono da LLM — o jev-enhancer nunca chama Anthropic/OpenAI.
3. O jev-enhancer é dono do protocolo de review.
4. Jev fica fora do loop de geração.
5. Core independente de harness; adapters pequenos.
6. Indexadores são opcionais, não requisito.
7. Tudo que puder ser determinístico, é determinístico.
8. **Fail-open**: falha nenhuma pode impedir o agente de continuar. Chave
   ausente, Jev fora do ar, git lento, bug nosso — tudo sai em silêncio,
   registrado no log.

## Configuração

`.jev/config.yaml`:

```yaml
review:
  passes: [correctness, tests]

rules:            # os arquivos de instrução do seu repo
  - AGENTS.md

gate:
  min_diff_lines: 20
  code_extensions: [.go, .gd, .ts]
  ignore_paths: [docs/]

deterministic:    # SEUS checks; devem sair 0 e imprimir JSON
  commands:
    - ./tools/prrules --json

verify:
  enabled: true
```

Ferramentas específicas do seu projeto entram como comandos — não viram
dependência do jev-enhancer.

**Chaves** (`TYPESAFE_AI_API_KEY`) só por ambiente ou `.env`. Nunca por
argumento de CLI: argumento vaza em histórico de shell e em log de CI.

## Comandos

| comando | para quem |
| --- | --- |
| `jev init` | você — cria a config no repo |
| `jev apply claude` | você — instala o adapter e valida |
| `jev status` | você — `never_run` / `skipped` / `completed` / `failed` |
| `jev prepare` | o adapter — gate + contexto (JSON) |
| `jev verify` | o adapter — triagem dos achados (JSON) |

`jev status` distingue explicitamente **never_run** de "rodou e não achou
nada". O estado mais perigoso é a ferramenta nunca ter disparado sem ninguém
notar.

## Self-test da instalação

`jev apply claude` separa duas naturezas de falha:

- **estrutural** (hook não registrado, arquivo ausente, settings inválido) →
  a instalação **falha**, porque está errada;
- **dependência externa** (Jev fora do ar, chave ausente) → **diagnóstico**
  claro, instalação segue válida — ela está correta e volta a funcionar quando
  a dependência voltar.

A instalação é idempotente e preserva hooks de outras ferramentas.

## Estado (v0.1 — milestone 1)

Implementado e testado ponta a ponta: `init`, `apply claude`, `prepare` com
cost gate, session guard com limite defensivo, bloqueio único, `status`.

`verify` está **simplificado de propósito** (ordena por severidade declarada,
sem chamar o Jev) — o objetivo do milestone 1 é provar que o ciclo automático
fecha sem loop e sem atrapalhar o agente. O verificador real entra em seguida,
trocando só o corpo de `verifyFindings`; o contrato de saída já é o definitivo.

Ainda não implementados: indexadores, autofix, V3 iterativa, outros harnesses,
modo self-contained.
