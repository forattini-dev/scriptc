# Baldim: aceite nativo de storage-key e captura de stack em Rust

Checkpoint de 2026-10-02. Dois consumidores de `@baldim/core/storage-key`, usando o pacote npm original `@baldim/core@0.2.1` sem alterações em suas fontes, compilaram e executaram como binários Rust estáveis sem engine JS e sem FFI externa. Isso não significa que o pacote completo, o adapter S3, redwall ou redskilled já compilem integralmente.

## Evidência dos consumidores reais

Os dois programas foram comparados byte a byte com Node 24.15.0: stdout, stderr, código de saída e sinal coincidem. Ambos terminaram com código 0, stderr vazio e auditoria de heap habilitada. O toolchain usado foi Rust 1.98.0 stable; os relatórios de compilação registram `engine: none`, `externalFfi: false` e nenhuma runtime fence declarada.

- Caminho válido: [.red/tmp/baldim-rust-20261001-nDbseO/results/core-storage-key-stack-checkpoint-20261002/parity.json](../../tmp/baldim-rust-20261001-nDbseO/results/core-storage-key-stack-checkpoint-20261002/parity.json). Exercita construção de chave e validação de caracteres; hash de stdout `14ac8b036b193db5c49697a5b9e8df6a778c4cef0c43209df7cc36f4e71014db`.
- Caminho inválido: [.red/tmp/baldim-rust-20261001-nDbseO/results/core-storage-key-invalid-stack-coordinate-final-20261002/parity.json](../../tmp/baldim-rust-20261001-nDbseO/results/core-storage-key-invalid-stack-coordinate-final-20261002/parity.json). Exercita o `ValidationError` original, sua mensagem e representação; hash de stdout `53e1604accfb47df29d0b78540bbb5ab5076d01249ed92bef0c98f04b582b5c7`.

As comparações finais foram registradas em 2026-10-02T15:04:37Z. Os relatórios preservam hashes dos consumidores e das fontes originais `errors.js` e `storage-key.js`. Os artefatos em `.red/tmp` são evidência local, não substituem testes permanentes versionados. A comparação do caminho inválido não demonstra igualdade de uma stack completa: esse consumidor imprime representações do erro, não todos os seus frames.

## Implementação e limites

Foi implementado um subconjunto síncrono de `Error.captureStackTrace`, exclusão por identidade de função/construtor, leitura lazy de `.stack` e captura automática na criação de erros. A localização usa metadados das fontes originais no IR, não coordenadas do Rust gerado. A identidade do construtor é independente de seu `.name` mutável. Os frames e caches usam guardas de escopo e referências fracas; o runtime continua sem código unsafe.

Os testes fixaram avaliação única de receivers, coluna de chamadas de membro, exclusão de construtores herdados, layout de classes singleton, URLs ESM e nomes CJS. Também fixaram a forma usada pelo Baldim: `typeof Error.captureStackTrace` seguido de um fallback que escreve `.stack`. A primeira guarda de escrita era ampla demais e bloqueava o programa mesmo quando esse ramo não executava; a correção preserva o ramo morto e emite uma recusa explícita `SC1031` quando uma escrita não suportada realmente executa.

Não há promessa de paridade de strings completas de stack com Node. Os frames de VM/loader não são reproduzidos; nomes de funções importadas/mangleadas e callbacks indiretos precisam de qualificação adicional. Arbitrary targets, hooks de formatação, escrita em stack e `stackTraceLimit` configurável não estão qualificados. A coexistência com funções async/generator retidas é recusada conservadoramente. Classes com propriedades/accessors próprios conflitantes continuam delimitadas. C e LLVM não receberam esse suporte.

O contrato de referência é a [documentação oficial de erros do Node 24.15.0](https://nodejs.org/download/release/v24.15.0/docs/api/errors.html). A documentação de limitações foi atualizada para explicitar o subconjunto e as diferenças. Nenhum status positivo do inventário estático compartilhado frontend/C foi ampliado com base apenas em testes Rust.

## Validação realizada

- Arquivo de testes da API: 20 testes passaram, incluindo oito fixtures diferenciais em dev e release, recusas de compilação e uma recusa explícita em execução.
- Rodada conjunta de API/IR/metadados: 42 testes passaram em três arquivos. Depois foi acrescentado o teste de isolamento de coordenadas por arquivo; a rodada IR/metadados subsequente passou com 23 testes. O consumidor inválido original foi recompilado e comparado novamente após esse ajuste final.
- Runtime Rust: três testes focados de source stack passaram; `cargo clippy --all-targets -- -D warnings` passou no toolchain estável.
- Build dos pacotes do workspace, TypeScript do compilador, ESLint dos novos helpers/testes e `git diff --check` passaram.
- Geração/check de dispatch de backends passou com 1295 spellings. A geração do surface manifest passou via `node --import tsx scripts/surface-manifest.mjs`, sem mudança do arquivo gerado.
- `pnpm node-compat:check` passou: 4690 linhas internas, 3662 públicas e 54 módulos de island, para o pin Node 24.15.0.

Uma rodada mais ampla de seis arquivos atingiu timeout de 300 segundos. Antes disso, os arquivos de Object.assign, instance constructor e Error.toString terminaram verdes individualmente; isso não é um aceite agregado dessa rodada. As duas lanes completas plain e sanitized ainda não passaram nesta etapa. O gate de linhas congeladas ainda apresenta dívida existente; a extração do contexto de libCall reduziu `expressions.ts` a 1172 linhas sem elevar teto.

O gate de docs foi tentado com `NEXT_DIST_DIR=.next-check pnpm check`, mas parou antes do build em `ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE`: a verificação da identidade do pnpm precisa de acesso ao registry, indisponível neste ambiente. A verificação não foi desabilitada. O fetch de `origin/main` também permanece impedido pela permissão de escrita em `.git/FETCH_HEAD`. Não houve commit ou push. Esta etapa não está qualificada para shipping enquanto os gates obrigatórios estiverem pendentes.

## O que ainda bloqueia os programas maiores

O consumidor pela entrada raiz de `@baldim/core` ainda não compila nativamente: a expansão do grafo inclui banners com `node:module/createRequire`, dependências sem superfície tipada admitida e problemas de require/ordem de inicialização. O consumidor equivalente executa no Node, mas sua execução nativa não foi provada.

O probe de construção do cliente S3 também ainda falha na compilação, com cinco diagnósticos `SC2013`. A análise identifica `@baldim/adapter-s3` recusado por incompatibilidade com sua superfície tipada inferida. Há bloqueios separados em recker (`node:dns/promises`), destructuring de require JSON em thread-stream e ordem de binding de require em pino-std-serializers, além de dependências sem declarações admitidas. A indicação `static` de alguns pacotes AWS/Smithy na análise significa admissão do frontend, não prova de compilação nativa integral.

O probe S3 usa credenciais dummy e endereço local sem serviço. Não houve operação S3 remota, envio de dados ou uso de credenciais reais.

## Próxima sequência

1. Minimizar a divergência entre os exports reais de `@baldim/adapter-s3` e sua superfície inferida, localizar o diagnóstico de origem e corrigir o compilador sem remendar o pacote ou retirar APIs do consumidor.
2. Repetir o build nativo do probe S3 após essa correção. Tratar os bloqueios seguintes por família coerente: resolução DNS, require JSON e ordem de inicialização, distinguindo política de admissão de capacidade ausente no runtime.
3. Tratar separadamente os banners `createRequire` da entrada raiz de core; não confundir esse grafo com o grafo do probe S3.
4. Manter evidência diferencial Node/binário a cada fatia; ampliar depois para operações offline relevantes e para os consumidores redwall/redskilled. Construir o cliente não prova comportamento de CRUD S3.
5. Executar ambos os gates completos, o gate de docs e reconciliar `origin/main` antes de considerar a entrega pronta.

As skills diagnose e TDD orientaram a minimização e os testes pela API pública compile → execução nativa → oráculo Node. A guarda de serialização preservou os formatos existentes de IR e relatórios, sem migração de formatos neste trabalho.
