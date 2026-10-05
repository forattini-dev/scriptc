# Node 26 como foco; Node 24 como compatibilidade

Decisão explícita do mantenedor em 2026-10-02: focar Node 26 e manter suporte ao Node 24. O trabalho no compilador TS → Rust stable, incluindo Baldim e posteriormente redwall/redskilled, passa a validar primeiro o alvo `node26`, com Node 24 como regressão de compatibilidade. Isso não implica engine JS, nightly Rust ou remoção do suporte existente ao 24.

## Mudança aplicada

O job `node_26_host` em `.github/workflows/ci.yml` passa a se chamar “Node 26 focus, Node 24 compatibility” e inclui duas etapas semânticas para as regressões recentes relacionadas ao Baldim: `npm-static-null-defaults.test.ts` e `error-stack-capture.test.ts`. A primeira define `SCRIPTC_RUNTIME_TARGET=node26` e usa o executável Node 26 como oráculo; a segunda seleciona `node24` e usa o executável Node 24. O job instala também o toolchain Rust pinado pelo runtime. O smoke C e o inventário existente conservam o denominador Node 24 auditado. A mudança não confunde host do compilador com alvo do binário.

O YAML foi parseado localmente e as duas etapas foram inspecionadas por assertions: ordem 26 → 24, oráculos correspondentes, ambos os arquivos de teste e um worker por execução. A execução do workflow no GitHub não foi realizada neste ambiente.

As duas rodadas locais terminaram verdes: 27 testes no Node 26.10.0 com `SCRIPTC_RUNTIME_TARGET=node26`, em 124,32 segundos, e 27 testes no Node 24.15.0 com `SCRIPTC_RUNTIME_TARGET=node24`, em 123,31 segundos. Cada rodada usa seu próprio Node como oráculo. São 20 testes de stacks e sete de null defaults, com binários dev/release, comparações de bytes e limites explícitos de recusa; não constituem uma suite completa de compatibilidade Node.

## Versões e limites de evidência

O perfil existente de `node26` e o CI continuam pinados em 26.8.1. O executável disponível localmente é 26.10.0. A busca nas instalações e caches locais não encontrou 26.8.1; a tentativa de acessar o download oficial falhou por resolução de DNS. Os testes locais desta rodada registram 26.10.0, não se apresentam como execução do pin 26.8.1 e não ampliam o inventário por inferência. O Node 24 local usado na regressão é o pin 24.15.0.

Não foram trocados `.node-version`, o primary de `NODE_COMPAT_MATRIX`, identidades de runtime, inventários gerados ou claims públicas. A prioridade de engenharia agora é 26; a promoção dos defaults técnicos e do denominador público continua uma migração separada, que precisa de evidência por alvo. Trocar apenas o número do pin preservaria silenciosamente oráculos, mensagens e testes do 24, sem estabelecer a compatibilidade desejada.

## Probes originais do Baldim

Os consumidores originais `core-storage-key.ts` e `core-storage-key-invalid.ts`, com `@baldim/core` 0.2.1 não modificado, compilaram com `target: node26`, backend Rust e `allowEngine: false`. A comparação com Node 26.10.0 passou byte a byte para stdout, stderr, exit code e sinal. Ambos têm `engine: none`, `externalFfi: false`, nenhuma runtime fence declarada e execução com auditoria de heap. Os builds levaram aproximadamente 3,2 e 3,0 segundos, com RSS máximo do processo de 349468 e 326072 KiB, respectivamente.

Os artefatos locais estão em `.red/tmp/baldim-rust-20261001-nDbseO/results/core-storage-key-node26-focus-20261002/` e `core-storage-key-invalid-node26-focus-20261002/`, cada um com `probe.json`, `parity.json` e o executável. Os relatórios registram hashes das fontes originais. Isso comprova esses consumidores, não o pacote inteiro nem operações S3.

O build original de `s3-client.ts` foi repetido explicitamente para `node26`, usando o host Node 26.10.0. Falhou sem produzir binário, em 91,394 segundos e com RSS máximo do processo de 659936 KiB. O relatório em `.red/tmp/baldim-rust-20261001-nDbseO/results/s3-client-node26-focus-20261002/probe.json` conserva as mesmas famílias do probe 24: dois SC2020 de promisify/zlib, quatro SC2013 de pino/recker, um SC2011, um SC1090 e um SC2004. Mudar o major não remove esses gaps do compilador. Não foram executadas operações remotas de S3.

## Próxima fatia de implementação

Priorizar `util.promisify(deflateRaw)` e `util.promisify(inflateRaw)`, usados realmente pelo core em `text-compression.js`. Os testes devem compilar para Node 26 e comparar com seu oráculo primeiro; repetir a evidência para Node 24. Qualificar buffers, opções, bytes, round-trip, erros e rejeições antes de ampliar qualquer claim. Em seguida, minimizar o bloqueio `_config_0` de `@aws-sdk/client-s3` e tratar por famílias as dependências de logger/transporte. Manter o consumidor S3 original como prova de integração, sem alterar fontes npm para fazê-lo passar.

As lanes completas plain/sanitized e gates pendentes dos checkpoints anteriores continuam necessárias antes de shipping. A validação desta rodada é focada. A política TDD orientou o uso dos testes públicos compile → binário → Node como critério de evidência; não houve mudança de formato de persistência ou wire do produto.
