# Baldim: recusa de inferência do adapter-s3 removida

Checkpoint de 2026-10-02. O consumidor original de `@baldim/adapter-s3` passou pela admissão estática e chegou ao lowering, mas continua sem gerar um binário nativo. Não foi modificada nenhuma fonte do pacote npm. Rust permanece no toolchain 1.98.0 stable, com `allowEngine: false`; não houve adoção de nightly, operação S3 remota ou commit/push.

## Causa reproduzida e correção

O diagnóstico que derrubava o adapter era `Type 'string' is not assignable to type 'null | undefined'`, localizado no campo `id` do objeto passado ao construtor. O JavaScript publicado contém `constructor({ ..., id = null, ... })`. A declaração pública permite string, e Node executa esse consumidor, mas a inferência da implementação estreitava o slot ao valor padrão null.

O problema foi reproduzido tanto no grafo original como num pacote mínimo: um construtor com `{ id = null, payload }` e um consumidor TypeScript que fornece uma string. O teste antes da correção falhou com `SC2013`, pois o pacote era enviado à island. A fixture JavaScript também falhou, com uma recusa de `??` sobre o tipo null-only inferido.

A correção tem duas partes. A admissão reconhece somente diagnósticos numéricos TS2322 em propriedades de argumentos literais diretos de calls/new, correspondentes a slots null-default não anotados de JavaScript de um pacote admitido. A superfície original de declarações precisa passar pelo preflight completo antes dessa exceção. O matcher exige proveniência do pacote, declaração do parâmetro, nome do slot, localização do diagnóstico e tipo inferido null/undefined; não decide por texto de mensagem. No lowering, um binding null-default lido de uma fonte que já é checked-dynamic permanece nesse mundo em vez de ser extraído como um valor null-only.

Não se copiam assinaturas de valores do `.d.ts` para o IR, não se alteram fontes ou offsets do pacote, e não se amplia a ABI de parâmetros estáticos. Uma tentativa inicial de ampliar o parâmetro inteiro foi removida na revisão: os testes continuaram verdes sem ela. Erros originais de TypeScript, erros não relacionados e contratos JSDoc explícitos continuam produzindo recusas. Objetos passados por variáveis, outras formas de default e todos os possíveis consumidores desse padrão não foram qualificados por esta fatia; uma recusa restante não deve ser apagada para ampliar a claim.

## Evidência permanente

`packages/compiler/test/npm-static-null-defaults.test.ts` contém sete testes: consumidores npm/TypeScript e JavaScript em dev/release comparados byte a byte com Node 24.15.0, mais três limites de admissão. Os quatro binários positivos têm `engine: none`, `externalFfi: false`, nenhuma runtime fence declarada e execução com auditoria de heap. String explícita, propriedade omitida, undefined explícito e null explícito produzem a mesma saída:

```text
explicit 1
generated 2
generated 3
generated 4
```

A evidência de corpus está em `tests/corpus/3392-js-null-default-pattern.js`; o pacote mínimo e seu consumidor ficam em `tests/fixtures/npm-static/`. A última rodada de null defaults e lifecycle passou com oito testes em dois arquivos. O teste de lifecycle confirma que os probes de atribuição não mantêm dois checkers vivos simultaneamente.

Também passaram onze testes selecionados do harness anterior de contexto de callbacks, incluindo suas recusas e invalidação de declarações em Rust/C/LLVM. Isso não é um aceite dos quinze testes desse arquivo: a rodada completa teve quatro falhas. Três falharam ao executar Node via `spawnSync`, com EPERM neste ambiente; uma divergência de status `static` no relatório de admissão foi reproduzida novamente com o predicado anterior de callbacks, sem a nova exceção de null defaults. O preflight desse último caso continua falhando corretamente; a classificação no relatório precisa de investigação separada. Os testes antigos não foram alterados para mascarar essas falhas.

O build dos pacotes, TypeScript do compilador, ESLint dos novos helpers/testes e `git diff --check` passaram. ESLint dos grandes arquivos de lowering não teve erros, mas conserva warnings existentes. `pnpm node-compat:check` passou com 4690 linhas internas, 3662 públicas e 54 módulos de island, para Node 24.15.0. Não houve ampliação das claims da matriz de compatibilidade.

As lanes completas plain e sanitized e demais gates pendentes do checkpoint anterior não estão verdes. O wrapper `pnpm limit` foi tentado, mas a conexão com o bus de cgroup é recusada; foram usados limites de workers e de heap Node, que não substituem um teto rígido de RAM. A última leitura de memória indicou aproximadamente 16 GiB disponíveis. Não foi encerrado nenhum processo.

## Resultado no pacote original

O [probe final de build nativo S3](../../tmp/baldim-rust-20261001-nDbseO/results/s3-client-null-default-final-20261002/probe.json) terminou em 88,9 segundos, com pico de RSS do processo de aproximadamente 774 MiB. A compilação falhou antes de produzir um binário, agora com nove diagnósticos em famílias concretas: dois SC2020, quatro SC2013, um SC2011, um SC1090 e um SC2004. Esse aumento no número de diagnósticos não é prova de regressão: a recusa inicial ocultava o grafo que agora alcança o lowering.

A [análise do grafo](../../tmp/baldim-rust-20261001-nDbseO/results/s3-client-null-default-analysis-20261002/probe.json) registra `@baldim/adapter-s3` e `@baldim/core` como `static`, no sentido de admissão do frontend. Isso não comprova compilação ou execução nativa integral de nenhum desses pacotes. O consumidor S3 original usa credenciais dummy, endereço local sem serviço e nenhuma operação de envio/CRUD.

O [probe original de storage-key inválido](../../tmp/baldim-rust-20261001-nDbseO/results/core-storage-key-invalid-null-default-checkpoint-20261002/parity.json) foi recompilado e comparado novamente com Node: saída idêntica, código 0, stderr vazio, sem engine e sem FFI externa. Os hashes das fontes originais de erros e storage-key permanecem os mesmos do checkpoint anterior. Essa verificação ocorreu antes de retirar a ampliação redundante da ABI; a rodada final de sete testes e o build S3 foram repetidos após essa retirada.

## Próximas famílias, em ordem proposta

1. Implementar a forma real usada pelo core: `promisify(deflateRaw)` e `promisify(inflateRaw)`. A recusa atual ocorre nas declarações de `text-compression.js`. O primeiro aceite deve comparar compressão/descompressão, opções relevantes, bytes, erros e rejeições com o Node pinado, não apenas verificar que o binding carrega. Referências: [util.promisify no Node 24.15.0](https://nodejs.org/download/release/v24.15.0/docs/api/util.html#utilpromisifyoriginal) e [zlib no mesmo pin](https://nodejs.org/download/release/v24.15.0/docs/api/zlib.html).
2. Minimizar a causa do binding bloqueado `_config_0` no construtor publicado de `@aws-sdk/client-s3`, começando por `getRuntimeConfig(configuration || {})`. SC2004 é propagação de um bloqueio, não sua causa; `unknown` e `client.destroy` no consumidor podem ser cascatas e não devem ser implementados como se fossem três gaps independentes.
3. Remover por famílias as recusas de dependências de logger/transporte: require JSON em thread-stream, inicialização de require em pino-std-serializers, admissão de atomic-sleep e `node:dns/promises` em recker. Verificar cada causa antes de mudar políticas de admissão.
4. Repetir o build original a cada família; só declarar o cliente nativo quando o executável realmente existir e tiver paridade. Depois ampliar operações offline e retomar os consumidores redwall/redskilled.

Diagnose e TDD orientaram a reprodução, a minimização e a redução da correção ao seam público compile → binário → Node. Os formatos existentes foram preservados; package.json é uma fronteira externa obrigatória do npm, e os relatórios locais mantêm o contrato JSON já utilizado pelos probes. Não foram introduzidos formatos de wire ou persistência do produto. O fetch de `origin/main` continua impedido pela permissão read-only em `.git/FETCH_HEAD`; a reconciliação necessária para landing permanece pendente.
