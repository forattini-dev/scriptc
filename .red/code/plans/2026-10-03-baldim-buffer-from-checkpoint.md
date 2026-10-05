# Buffer.from dinâmico nativo em Rust

Em 2026-10-03, a chamada `Buffer.from(value, 'utf-8')` que bloqueava o consumidor original de compressão do Baldim passou a baixar para Rust nativo. O build desse consumidor caiu de sete para seis SC3003, sem alterar o pacote npm. Ainda não há binário do consumidor: os diagnósticos restantes vêm do encoder Base85 e seus arrays JavaScript. Este checkpoint qualifica uma fatia do compilador, não TS arbitrário para Rust nem Baldim completo.

## Escopo implementado

O frontend retém entradas checked-dynamic em `buffer.fromDyn`, com encoding omitido ou literal normalizado. O Rust faz dispatch por tipo em runtime, sem engine JS nem FFI externa. O IR valida dois argumentos, resultado bytes u8 e possibilidade de throw. O caminho typed existente de Buffer.from permanece separado.

Há testes diferenciais de strings UTF-8, strings vazias, encodings hex/base64/latin1/UTF-16LE, cópias independentes de Buffer/Uint8Array e views com offset, arrays com coerção numérica para bytes, objetos array-like com comprimento numérico e objetos serializados `{ type: 'Buffer', data: [...] }`. BigInt/Symbol como elementos lançam os erros de conversão correspondentes; entradas inválidas preservam name, code e message do Node nos casos testados.

Funções nativas `valueOf` em objetos e arrays são consultadas antes da conversão array-like. Os testes cobrem receiver `this`, retornos string/array, retorno do próprio objeto, retorno numérico ignorado, propriedade falsy, propriedade truthy não callable e exceções lançadas pela conversão. O teste de array com valueOf próprio pegou uma divergência real: copiar primeiro os elementos ignorava a conversão que o Node executa. A emissão foi corrigida.

Non-u8 typed arrays ainda são recusados ao cruzar a fronteira checked-dynamic, com SC1101 encapsulado em SC3003 no modo sem engine. Descritores de acesso dinâmicos continuam com sua recusa runtime explícita; o programa de getters foi preservado como fixture de fronteira, não apresentado como paridade aprovada. Object.create com um protótipo typed continua recusado com SC2020. Free-standing ArrayBuffer, encodings não literais e Symbol.toPrimitive não foram implementados por esta fatia. Proxy como argumento de Buffer.from agora tem recusa explícita, em vez de ser tratado como uma entrada inválida do Node.

Conversão valueOf além de 128 níveis tem recusa nomeada. Antes dessa proteção, uma fixture com dois objetos que devolvem um ao outro terminava o processo nativo por sinal em dev e release. Depois da proteção, termina com exit 1 e a mensagem documentada, sem sinal e com auditoria de heap. Isso é uma fronteira do compilador, não paridade de recursão com o Node.

## Evidência de testes

O gate novo é `packages/compiler/test/buffer-from-dynamic.test.ts`. Os oito programas diferenciais são `tests/corpus/3397` a `3404`; as fixtures de fronteira ficam em `tests/fixtures/buffer-from-dynamic/`. Cada teste positivo compila pela API pública, exige engine none e externalFfi false, executa o binário com auditoria de heap e compara stdout, stderr, exit e sinal byte a byte com o Node. Os testes usam stdio em arquivos para manter a comparação estrita neste sandbox, onde a captura por pipes não funciona confiavelmente.

- Node 26.10.0, alvo node26: a rodada completa inicial aprovou 24 testes em 143,153 segundos, com duração total de 149,58 segundos. São 16 comparações diferenciais dev/release e oito testes de fronteira. Posteriormente passaram, em rodadas focadas, dois testes adicionais de recusa de protótipo e dois testes de recusa C/LLVM.
- Node 24.15.0, alvo node24: os mesmos 24 testes passaram em 140,107 segundos, com duração total de 147,19 segundos. Os quatro testes adicionais também passaram em rodadas focadas. Não se afirma que todos os 28 foram executados juntos em uma única rodada.
- Os programas antigos `1402-buffer-encodings.ts` e `1661-buffer-encodings-full.ts` passaram em comparação estrita entre Rust dev/node26 e Node 26.10.0, com auditoria de heap.
- Os 34 testes de native-module/proxy/date/bigint/callable-record support passaram após a correção da fronteira dos emitters diretos. TypeScript do compiler, ESLint dos módulos novos, do checked Buffer e do guard de backend, parsing YAML do CI e git diff check passaram.

O pin técnico Node 26 e do CI continua 26.8.1; o executável disponível e efetivamente usado localmente é 26.10.0. Essa evidência local do 26 é exploratória, não execução do pin. O pin 24.15.0 foi executado. Rust stable 1.98.0 foi mantido; não foi adotado nightly nem alterado o primary da matriz.

## Fronteira C e LLVM

A emissão nova é Rust-only. O teste público encontrou um erro interno no C quando a IR nova chegava ao dispatcher de cryptoBytes; LLVM já recusava a libcall. O guard comum de backend agora reconhece buffer.fromDyn e devolve SC3001 para C/LLVM antes da emissão.

A qualificação também revelou que emitCModule e emitLlvmModule importavam o guard comum sem aplicá-lo. O teste existente de metadata de avaliação de módulo falhava porque a emissão direta ignorava a metadata. As duas entradas agora aplicam o guard existente, e os 34 testes de suporte nativo relacionados passaram. Não foi implementado Buffer.from dinâmico em C/LLVM nem inflada a lista de backends: a tabela gerada continua atribuindo buffer.fromDyn apenas a Rust.

## Build original do Baldim

O último probe de `core-compression.ts`, importando compressTextAsync/decompressTextAsync pelo subpath público original, falhou em 1,427 segundos, com RSS máximo de 323460 KiB, sem binário. O relatório está em `.red/tmp/baldim-rust-20261001-nDbseO/results/core-compression-buffer-final-20261003/probe.json`. Os seis SC3003 são dois construtores Array com any[], três escritas derivadas da representação inválida dos arrays e um SC2004 derivado de chars. Não resta a recusa de Buffer.from nesse consumidor.

O `@baldim/core` instalado permanece 0.2.1. O SHA-256 de `dist/concerns/text-compression.js` permanece `1e5587720d1878156dc5f2b4216e31bda2026df4d6832c31c3a2a9812ae56e14`, igual ao checkpoint anterior. As fontes npm não foram reescritas para satisfazer o compilador. O consumidor S3 completo, redwall e o daemon não foram rebuildados nesta fatia; seus resultados anteriores não foram promovidos a sucesso.

## Registros e gates pendentes

O build recursivo do workspace passou, incluindo cargo check do runtime. Os scripts regeneraram o surface manifest, a tabela de libcalls e a compatibilidade offline; node-compat check passou. A tabela está atual com 1298 spellings, um acréscimo sobre o checkpoint anterior. O artefato público de compatibilidade e o registry dinâmico não mudaram em relação ao HEAD. Não se alteraram statuses para anunciar Buffer.from completo nem se editaram arquivos gerados à mão.

As tentativas completas plain e sanitized usaram um worker e bail no primeiro erro. Plain voltou a falhar em 001-hello.ts: o Rust imprime hello world, enquanto a captura por pipe do oráculo aparece vazia. Sanitized falhou no contrato de invalidação de artefatos nativos com spawnSync EPERM, após quatro testes aprovados. Nenhuma lane completa está qualificada; os asserts, sanitizers e contratos permaneceram intactos.

O gate dos docs, com NEXT_DIST_DIR=.next-check, não iniciou porque a identidade do pnpm 10.23.0 não pôde ser verificada no registry na rede restrita. O check global de ceilings continua vermelho, inclusive em arquivos tocados e com dívida anterior; os limites não foram elevados. A memória observada tinha cerca de 16 GiB disponíveis de 18 GiB, sem pressão aparente. Foram mantidos um worker de testes por comando e um job Cargo/nativo; isso não é um teto rígido de RAM. A lista de processos é limitada pelo namespace do sandbox.

O ESLint adicional dos emitters C/LLVM terminou com seis erros de imports não usados e 73 warnings. Os imports apontados já existiam antes das chamadas ao guard adicionadas nesta fatia; não foram removidos incidentalmente. O resultado verde de ESLint acima se limita aos módulos novos, checked Buffer, teste novo e guard comum, não a todos os arquivos tocados nem ao lint completo.

Git fetch origin main foi novamente recusado porque `.git/FETCH_HEAD` está somente leitura. Não houve reconciliação, commit nem push. O WIP anterior foi preservado. Essas pendências impedem shipping e a reconciliação exigida antes da próxima fatia.

## Próximo alvo

Representar nativamente os arrays JavaScript usados pelo Base85: comprimento inicial, buracos, crescimento, escrita de strings e join. A primeira fixture deve reproduzir o padrão original `new Array(n)` sem anotar ou reescrever o npm; depois, repetir o consumidor original até produzir e executar um binário.

Produzir esse binário ainda não fecha a qualificação: os bytes de compressão Rust divergem do Node em vetores maiores, conforme o [checkpoint de promisify zlib](2026-10-03-baldim-promisify-zlib-checkpoint.md). Igualdade de encodings, thresholds e bytes comprimidos permanece critério separado. Depois vêm os blockers restantes do consumidor S3 original e os gates completos em ambiente apto.

A implementação seguiu TDD pela fronteira pública fonte → compilação → binário → Node, preservando recusas onde os testes revelaram limites de representação. A skill de serialização manteve os contratos existentes; não houve novo formato de persistência ou wire. Este documento segue o destino local do projeto, sem publicação externa.
