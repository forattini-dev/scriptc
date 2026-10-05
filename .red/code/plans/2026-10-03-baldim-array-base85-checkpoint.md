# Arrays JavaScript e Base85 do Baldim em Rust

Em 2026-10-03, as seis recusas restantes de arrays do consumidor original de compressão do Baldim foram removidas. Esse consumidor agora compila e executa um binário Rust sem engine JavaScript nem FFI externa. O encoder e o decoder Base85 originais passaram em quinze vetores contra Node. Isso não fecha o Baldim inteiro: os bytes comprimidos ainda divergem do Node, e o consumidor S3 original ainda não gera binário, com sete diagnósticos.

## Implementação qualificada

O novo `packages/compiler/src/frontend/lowering/lower-dynamic-array-constructor.ts` baixa as formas inferidas de `Array()` e `new Array()` que precisam de armazenamento dinâmico no backend Rust. O caminho cobre arrays JavaScript inferidos, argumentos heterogêneos e arrays TypeScript `unknown[]`, preservando os caminhos estáticos tipados existentes. Um argumento numérico estabelece o comprimento; um argumento não numérico é um elemento, sem transformar a string `"3"` em comprimento. A avaliação do argumento ocorre uma única vez, antes da alocação. A implementação reutiliza IR e libcalls existentes, sem adicionar ABI, engine ou caminho C.

O backend Rust passou a consultar a presença real dos elementos dinâmicos, em vez de considerar presente qualquer índice abaixo de `length`. A leitura de buracos retorna `undefined`, e a escrita em um índice distante usa o bookkeeping esparso existente, sem preencher os buracos com elementos presentes. O índice máximo de array é estritamente menor que `4294967295`; essa última chave é uma propriedade ordinária. A emissão de `in` compartilha o helper de presença, eliminando uma segunda implementação divergente. A correção é do caminho de arrays dinâmicos; não estabelece paridade universal dos arrays tipados.

Coerção de objetos atribuídos a `array.length` continua fora do escopo qualificado. Em vez de produzir um falso `RangeError` para um objeto com `valueOf()` válido, o Rust recusa explicitamente esse caso com `Error: scriptc: native array length coercion from objects is not supported yet`. Spread no construtor e bitwise sobre entrada JavaScript inteiramente `any` também continuam com diagnósticos explícitos. Esses testes fixam limites, não são provas de paridade positiva. Nenhum ceiling foi aumentado para acomodar a implementação.

Uma anotação explícita de tipo em `RustEmitter.expressionEmitter` resolveu o ciclo de inferência TypeScript exposto pelo check local. O CI existente de foco Node 26 e regressão Node 24 inclui o novo teste de arrays; o workflow não foi executado remotamente neste ambiente.

## Testes e builds

- Node 26.10.0, alvo `node26`, Rust stable 1.98.0: os três arquivos de arrays, Buffer.from dinâmico e promisify zlib passaram juntos, com 60 testes em 341,42 segundos de runner.
- Node 24.15.0, alvo `node24`, mesma toolchain Rust: os mesmos 60 testes passaram juntos em 309,85 segundos de runner.
- Os 19 testes de arrays incluem seis programas diferenciais nas otimizações dev e release, duas recusas de compilação, duas recusas explícitas de coerção de objetos em runtime e três regressões antigas de arrays dinâmicos.
- Os programas diferenciais positivos comparam stdout, stderr, status e sinal exatamente com Node, verificam ausência de engine e FFI externa e executam auditoria de heap. O harness usa arquivos de stdio porque a captura por pipe apresenta restrições neste sandbox; não foram relaxadas as comparações.
- Os novos programas são `tests/corpus/3405` a `3410`, incluindo comprimento, buracos, presença de `undefined`, truncamento, crescimento, limites, chaves não canônicas, identidade, ordem de avaliação e o padrão Base85 original. No programa mínimo Base85, apenas a entrada tem o ABI Uint8Array descrito pelo pacote original; os arrays construídos continuam sem anotações. Isso não modifica o pacote npm.
- O build recursivo do workspace passou depois das últimas mudanças de produção. Passaram também o check TypeScript direto, o ESLint dos novos arquivos e dos helpers Rust tocados, o check da tabela de backend libcalls e `pnpm node-compat:check`.

O pin de Node 26 do projeto continua 26.8.1, mas o executável local disponível é 26.10.0. Portanto, a evidência local do 26 não substitui a execução do pin. O Node 24.15.0 foi executado exatamente. Não houve troca para nightly, alteração do denominador público de compatibilidade ou mudança dos pins nesta fatia.

Os geradores produziram o surface manifest e o ledger de compatibilidade pelos scripts do projeto, sem editar arquivos gerados manualmente. O artefato público e o header do registry dinâmico permaneceram sem diff contra HEAD. Não foram ampliadas declarações de suporte Node somente para refletir a admissão do construtor de arrays.

## Consumidores originais

O `@baldim/core` instalado é 0.2.1 e permanece sem patches nas fontes npm. O SHA-256 de `dist/concerns/text-compression.js` foi conferido novamente: `1e5587720d1878156dc5f2b4216e31bda2026df4d6832c31c3a2a9812ae56e14`.

O probe `core-base85.ts` importa encoder e decoder pelo subpath público original e testa quinze vetores: vazio, blocos parciais, valores extremos, blocos completos e UTF-8. Todos tiveram stdout, stderr, status e sinal idênticos entre Node e binário Rust, com auditoria de heap, em Node 26 dev, Node 26 release e Node 24 dev. A última compilação release do 26 levou 13,761 segundos e RSS máximo de 326264 KiB. Não se afirma execução do consumidor original em Node 24 release; essa otimização foi coberta pelo programa diferencial permanente.

O último build de `core-compression.ts` levou 2,679 segundos, com RSS máximo de 327328 KiB e zero diagnósticos. O relatório é `.red/tmp/baldim-rust-20261001-nDbseO/results/core-compression-array-final-20261003/probe.json`. A execução desse binário final confirmou engine `none`, `externalFfi: false` e ausência de runtime fences. Node e Rust saíram com código zero, stderr vazio, round-trip verdadeiro e retorno `tiny` no caminho curto. A saída comprimida continua diferente:

```text
Node 26: z:y0jNyclXyMAgk/NzC4pSi4sz8/MUyvOLsosVHs1oxqJuVPWo6sGsGgA=
Rust:    z:y0jNyclXyMAgk/NzC4pSi4sz8/MUyvOLsosVHs1oxqJuVPVomBQN4nQCAA==
```

O executável local Node 26 reporta zlib `1.3.2.1-motley-285e94b`; o runtime Rust usa flate2 com zlib-rs. A família motley também consta no [header oficial do Node 26.8.1](https://raw.githubusercontent.com/nodejs/node/v26.8.1/deps/zlib/zlib.h). Essa diferença de implementação orienta a investigação, mas não prova sozinha a causa exata do vetor divergente. Round-trip não substitui igualdade de bytes.

O S3 original foi recompilado após esta fatia, sem executar operações nem acessar serviço remoto. O build falhou em 92,846 segundos, com RSS máximo de 661936 KiB, e continua com sete diagnósticos: quatro SC2013 de pino/recker, um SC2011 no consumidor, um SC1090 em `client.destroy` e um SC2004 derivado de `_config_0` no AWS SDK. O relatório está em `.red/tmp/baldim-rust-20261001-nDbseO/results/s3-client-array-20261003/probe.json`. O SC2004 exige localizar o blocker original da configuração; não é uma funcionalidade independente a habilitar. Redwall e o daemon redskilled não foram recompilados nesta fatia.

## Qualificação ainda pendente

As duas lanes completas foram tentadas novamente, sequencialmente, com Node 24.15.0, um worker e bail no primeiro erro. A plain parou depois de quatro testes aprovados com `spawnSync /tmp/scriptc-runtime-shadow-.../project/first EPERM`, no teste de invalidação de artefatos por novo header. A sanitizada parou no mesmo contrato, também depois de quatro testes aprovados. Nenhuma lane completa está verde; os 60 testes focados não substituem esse gate. As recusas de execução do ambiente não foram contornadas desativando asserts ou sanitizers.

O lint ampliado de `lower-containers.ts` ainda encontra o `buildArrayFromArrayFn` não utilizado que já existe em HEAD, além de warnings anteriores. O check global de ceilings segue vermelho por dívida existente, incluindo `lower-containers.ts`, agora com 8524 linhas frente ao limite de 7734. O novo helper tem 58 linhas e `backend/rust/dynamic.ts` tem 1175, abaixo do limite de 1200. Esses checks não foram declarados aprovados nem seus limites alterados.

O limitador por cgroup não pôde acessar o user bus. Foram usados um worker por comando, um job Cargo/nativo e heap Node de 1,5 GiB; isso não equivale a um teto rígido de RAM. A observação local indicou cerca de 13 GiB disponíveis, sem pressão aparente; o namespace limita a visão dos processos. Nenhum processo alheio foi encerrado.

O mantenedor autorizou explicitamente continuar desenvolvimento local sem o checkpoint de fetch/reconciliação enquanto `.git/FETCH_HEAD` está somente leitura e a resolução de GitHub está indisponível. Essa autorização não foi ampliada para shipping. Não houve commit, push, reset ou sobrescrita do WIP concorrente. Os gates completos, a reconciliação e os demais bloqueios de shipping registrados nos checkpoints anteriores continuam pendentes.

## Próxima fatia

1. Minimizar o vetor de compressão divergente e comparar parâmetros, alimentação de entrada, flush e decisões do algoritmo com o pin Node 26.8.1. Corrigir a paridade no caminho Rust, mantendo os casos Node 24 e os diferenciais estritos, sem substituir o backend por C.
2. Requalificar `compressTextAsync`/`decompressTextAsync` originais nos encodings e thresholds do Baldim. O Base85 já é evidência positiva; o consumidor completo só fecha quando os bytes relevantes também coincidem.
3. Retomar as famílias pino/recker e o blocker original de configuração do AWS SDK, recompilando o consumidor S3 original a cada avanço. Só depois de gerar binário, executar contratos locais controlados antes de planejar CRUD real.
4. Rodar ambos os gates completos num ambiente que permita seus contratos, reconciliar origin/main e só então preparar shipping.

A disciplina TDD orientou a reprodução dos blockers originais e os ciclos red-green, incluindo a falha real de índice máximo e a duplicação incorreta de presença. O checkpoint documental separa implementação, evidência diferencial positiva, recusas e bloqueios de shipping; não afirma compilação arbitrária de TS para Rust nem conclusão do Baldim inteiro.
