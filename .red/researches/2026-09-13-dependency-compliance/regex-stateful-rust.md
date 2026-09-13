# Regex com estado: dependência real compilada em Rust

Continuação do checkpoint de [admissão AUTO com tipos de terceiros](auto-third-party-types.md), cujo commit é `0dacfa5a`. O `is-extglob@2.1.1` original instalado no RedSkills agora compila para Rust nativo com `allowEngine: false`. As 17 entradas do experimento produziram stdout, stderr e status idênticos aos do Node 24.15.0. Não houve alteração nos repositórios consumidores nem medição de performance neste ciclo.

## Causas corrigidas

1. O frontend recusava chamadas literais `.test()` e `.exec()` com `g`/`y`, apesar de o runtime Rust já implementar estado para `.test()`. O lowering agora recebe uma capacidade explícita por backend, propagada pelas passagens de alcance e cobertura.
2. `.exec()` era traduzido como `.match()`. Isso perde a semântica de uma única ocorrência quando a regex é global. O Rust agora recebe uma operação IR própria, que avalia o receptor antes do argumento e preserva `lastIndex`.
3. A conversão das capturas tipadas para armazenamento dinâmico copiava os elementos e descartava `match.index`. No `is-extglob`, isso fazia o recorte da string deixar de avançar e provocava um loop nas entradas escapadas. As projeções tipadas/dinâmicas agora compartilham o armazenamento e preservam `index` e `input`.
4. Capturas ausentes precisavam continuar `undefined`, inclusive em leituras de variáveis JS atribuídas por `.exec()` dentro de `while` e em expressões condicionais. A declaração otimista de captura como `string` na biblioteca padrão não pode apagar esse valor.

## Escopo e regressões

O Rust aceita leituras de `lastIndex` e atribuições numéricas simples em posições de instrução ou expressão. O valor atribuído é preservado; a conversão `ToLength` ocorre na execução. Os diferenciais cobrem aliasing, avanço/reset global e sticky, frações, negativos, NaN, infinito, índice além da string, pares de surrogates UTF-16, regex sem estado, matches vazios e a ordem de avaliação.

Os arrays de capturas de `exec`, `match` não global e `matchAll` carregam `index`/`input` no slot auxiliar existente. As views encaminham esses metadados ao array original. O handler novo inicialmente interceptou o índice auxiliar dos loops de `matchAll`, causando regressões nos programas 3094 e 3095; a precedência foi corrigida, e os três programas 3094/3095/3096 passaram novamente. O teste novo também cobre metadados de uma linha armazenada de `matchAll`.

As recusas de regex com estado em C/LLVM foram preservadas. IR serializada que contenha as operações exclusivas do Rust recebe `SC3001` nesses backends. Este ciclo não implementa atribuições não numéricas a `lastIndex`, operadores compostos, despacho arbitrário de regex por `any`, nem todas as formas de RegExp do JavaScript.

## Evidência reproduzível

- `tests/harness/rust-regex-stateful.test.ts` compila duas fixtures em Rust sem engine e compara stdout, stderr e status com Node. Também verifica erros/timeouts do subprocesso e habilita a auditoria de heap do runtime.
- `tests/fixtures/regex-stateful/main.ts` cobre os contratos de estado e capturas descritos acima.
- `tests/fixtures/npm-static/is-extglob-native/` contém os arquivos `index.js`, `package.json` e `LICENSE` byte a byte iguais aos da dependência real. Sua declaração local é uma fixture mínima de `@types`, suficiente para exercitar a admissão AUTO.
- O experimento separado importou a instalação original por symlink, adquiriu `@types/is-extglob@2.1.0` do npm e compilou novamente com lock frozen e modo offline. Análise sem diagnósticos, pacote marcado `static`, execução com `engine: none`, 17 casos equivalentes ao Node. [Evidência JSON](regex-stateful-evidence.json) registra as saídas, opções e SHA-256 dos arquivos originais; os caminhos temporários são somente localizadores desta execução.

## Validação

- Runtime no toolchain fixado 1.98.0: `cargo test`, 255 testes aprovados; `cargo clippy -- -D warnings` aprovado após a última alteração no runtime.
- Diferenciais finais plain: as duas fixtures novas e os três programas existentes de capturas passaram, 5 testes. Na seleção anterior de 11 programas de regex, os outros 8 já haviam passado; os casos inicialmente vermelhos foram corrigidos e reexecutados.
- Contratos do frontend e snapshots de regex: 5 testes passaram. O snapshot remove somente as duas recusas de `g`/`y` liberadas no Rust; o diagnóstico legado de `.exec()` agora identifica o método correto.
- Seleção final na faixa sanitized: 4 testes passaram (duas fixtures diferenciais novas e dois contratos de backend). O harness `rust-differential` ignora essa faixa e seus três casos selecionados não foram reexecutados nela. Isso não representa instrumentação ASan do runtime Rust. Log: `/tmp/scriptc-regex-focused-sanitized.log`.
- Build do compilador aprovada após corrigir a propagação da opção sob `exactOptionalPropertyTypes`. Lint aprovado com zero erros e 3140 avisos existentes. Limites de linhas reduzidos, sem aumento dos tetos congelados. Manifest regenerado; `pnpm node-compat` e `pnpm node-compat:check` aprovados, sem alterações nos artefatos da matriz de compatibilidade.
- Gates completos plain e sanitized com `--bail=1` interrompidos na falha preexistente de `native-toolchain.test.ts:330`: ausência de `ccache.log`; cada um terminou com 6 testes aprovados e 1 falha. Logs: `/tmp/scriptc-regex-full-plain.log` e `/tmp/scriptc-regex-full-sanitized-bail.log`. Uma tentativa sanitized sem `--bail=1` foi interrompida e substituída por essa execução limitada à primeira falha. A sessão Sandbox estava expirada no preflight do ciclo anterior; usamos o fallback local. Os gates completos ainda não estão verdes.

## Próximo bloqueio da missão

A aquisição de tipos e este avanço de regex fecham uma dependência real; não representam a build integral do Redcode. A contagem completa do CLI não foi refeita neste ciclo. O próximo passo é retomar o adaptador de covariância de Promise já isolado e os demais bloqueios nativos, mantendo separadas as falhas do compilador e as exigências legítimas de tipagem dos consumidores. Os gates completos precisam passar antes de publicar.
