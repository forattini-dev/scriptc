# Compressão nível 6 do Baldim com bytes Node em Rust

Em 2026-10-03, a divergência de bytes do consumidor original `compressTextAsync` do `@baldim/core` 0.2.1 foi reproduzida, minimizada e corrigida no codec Rust. O consumidor original e uma matriz ampliada com base64, Base85, textos curtos, vazios e threshold compilaram e executaram com stdout, stderr, status e sinal idênticos aos respectivos Nodes 26 e 24. Isso fecha os vetores desta fatia, não prova paridade para toda entrada de compressão e não fecha o cliente S3 do Baldim.

## Causa e correção

O runtime usa flate2 1.1.9 com zlib-rs 0.6.7. A implementação upstream escolhe `deflate_medium` no nível 6; o Node usa slow matching com good 8, lazy 16, nice 128 e chain 128. Trocar somente a função, mantendo o nível e seus parâmetros, corrigiu a divergência de `"abc".repeat(89)` e do texto original do Baldim. Mudar o tamanho de alimentação ou dos buffers não resolveu esses vetores, e não foi usado nível 7 como substituto de nível 6.

Um probe determinístico com 160 entradas adicionais revelou duas causas independentes. O vetor minimizado `02000302000302` exige inserir uma repetição quando restam três bytes de lookahead; o slow upstream exige quatro. O vetor `82f90493d6f9049356` distingue a função hash usada para escolher a cadeia de candidatos. O hash do Node na configuração padrão foi verificado independentemente nas instruções dos executáveis locais 26.10.0 e 24.15.0: `((value + 1) * 66521 >> 16) & 32767`, com aritmética u32 wrapping. Não foi adotado o hash CRC32C de Chromium.

Os três ajustes estão em `packages/runtime-rust/vendor/zlib-rs`, protegidos pela feature opt-in `scriptc-node-level6`. A feature desligada mantém o comportamento upstream. Os outros níveis, framing, descompressão e tuning não foram modificados. A integração é pelo Cargo, sem compressor C, nova FFI externa ou nightly. O runtime mantém `forbid(unsafe_code)`; os ajustes de algoritmo não introduzem unsafe. Isso não significa que a dependência upstream inteira seja livre de unsafe.

A licença upstream foi preservada, e `vendor/zlib-rs/PATCHES.md` identifica a distribuição alterada, checksum, fontes e limites. O lockfile foi atualizado pelo Cargo offline, sem mudanças de versões alheias. Nenhuma declaração de suporte Node foi ampliada só por adicionar a dependência.

## Evidência permanente

- Node 26.10.0, alvo node26: 21 testes aprovados nos arquivos `zlib-node-parity.test.ts` e `promisify-zlib.test.ts`, em 113,93 segundos de runner.
- Node 24.15.0, alvo node24: os mesmos 21 testes aprovados, em 100,27 segundos.
- Os oito novos testes executam quatro programas diferenciais em dev e release. Cobrem long matches, framing raw/zlib/gzip, o tail de três bytes e a escolha de hash. A execução confirma engine none, ausência de FFI externa e fences, igualdade byte a byte e auditoria de heap.
- Os programas permanentes são `tests/corpus/3411` a `3414`. O teste de long-text anterior deixou de aceitar bytes específicos divergentes do Rust e agora exige igualdade com Node, mantendo sua prova de interoperabilidade.
- Seis testes focados de zlib no runtime passaram. Os três novos testes fixam os vetores mínimos, framing e identidade entre o nível padrão e nível 6.
- O build recursivo do workspace, clippy all-targets do runtime com `-D warnings`, ESLint dos três testes tocados, Rustfmt dos arquivos Rust alterados, `git diff --check` e `pnpm node-compat:check` passaram. A dependência vendorizada expõe 77 warnings upstream; o sucesso do clippy do runtime não significa build global sem warnings.

O CI existente de foco Node 26 e regressão Node 24 inclui o novo arquivo de paridade. O workflow remoto não foi executado neste ambiente. O pin do projeto continua Node 26.8.1: o resultado local de 26.10.0 não substitui qualificar o pin. O 24.15.0 foi executado exatamente.

## Consumidor npm original

O SHA-256 de `@baldim/core/dist/concerns/text-compression.js` permanece `1e5587720d1878156dc5f2b4216e31bda2026df4d6832c31c3a2a9812ae56e14`. As fontes npm não foram remendadas.

O consumidor original `core-compression.ts` produziu a mesma string `z:y0jNyclXyMAgk/NzC4pSi4sz8/MUyvOLsosVHs1oxqJuVPWo6sGsGgA=`, round-trip verdadeiro e caminho curto `tiny` nos dois Nodes e binários finais. O build Node 26 release levou 15,957 segundos e RSS máximo 319120 KiB; o Node 24 dev levou 15,622 segundos e RSS máximo 373992 KiB.

A matriz `core-compression-level6.ts` chama as funções públicas originais com cinco textos e dois encodings, além de threshold e formas vazias. Ela imprime tanto o payload quanto o texto restaurado completo, com 3514 bytes de stdout idênticos em cada par Node/native. Os builds dev dos alvos 26 e 24 levaram 3,195 e 3,129 segundos, respectivamente. Todos os quatro binários finais foram reexecutados com `SCRIPTC_RUST_HEAP_AUDIT=1`, código zero, sinal nulo e stderr vazio.

Esses reports estão em `.red/tmp/baldim-rust-20261001-nDbseO/results/core-compression-level6-{node26,node24}-final-20261003` e `core-compression-level6-matrix-{node26,node24}-final-20261003`. Os reports temporários não substituem os testes permanentes. Uma comparação `===` direta sobre o retorno any do pacote gerou SC2011 no primeiro adapter; imprimir o valor restaurado inteiro possibilitou a comparação estrita sem casts ou alterações no npm. Esse limite do frontend não foi declarado resolvido.

## Empacotamento real

O teste novo `tests/harness/runtime-rust-package.test.ts` empacota o npm runtime, extrai o tarball em um diretório próprio fora do repositório e exige `cargo check --locked --offline --no-default-features` desse pacote. O Cargo inicialmente recusou exemplos ausentes do tarball; depois revelou que `data/text-decoder.bin`, usado por include_bytes, também estava ausente. A lista files agora inclui examples, data e a dependência vendorizada. O teste passou com os hosts Node 26 e 24 depois de ambas as correções, sem publicar pacote. Esta lane usa tar POSIX e não constitui qualificação do empacotamento Windows.

## Limites e shipping

Depois dos três ajustes, o probe de 160 entradas teve zero divergências no nível 6 contra os dois Nodes locais. Essa amostra finita não é prova para entradas arbitrárias nem percentual de compatibilidade. Os níveis 1, 4 e 5 têm diferenças observadas que continuam abertas. Opções explícitas de compressão síncrona e configurações não padrão não foram ampliadas nesta fatia.

Os gates completos plain e sanitizado foram tentados novamente, cada um com um worker e bail. Ambos pararam depois de quatro testes aprovados no contrato native-toolchain que executa um binário em diretório temporário, com `spawnSync .../project/first EPERM`. O cargo test completo coletou 275 testes, apresentou falhas nos contratos de rede/TCP/TLS/UDP e terminou com exit 1, sem resumo completo aprovado. Os seis testes zlib verdes não substituem esses gates. As comparações e os sanitizers não foram desativados para obter aprovação.

O check global de ceilings continua vermelho em 33 arquivos; o fmt global também encontra diferenças anteriores/WIP fora dos arquivos tocados. Não foram aumentados ceilings nem formatados arquivos alheios. O limitador cgroup não conseguiu conectar ao user bus; os comandos usaram limites explícitos de workers, Cargo/native jobs e heap Node, que não equivalem a um teto rígido de RAM. Nenhum processo alheio foi encerrado.

O mantenedor autorizou temporariamente desenvolvimento local sem fetch/reconciliação enquanto `.git/FETCH_HEAD` está somente leitura. Não houve commit, push ou sobrescrita do WIP concorrente. Shipping permanece pendente dos gates completos e da reconciliação.

## Próximo passo

Retomar o consumidor S3 original por famílias coerentes: primeiro os imports pino/recker e a causa primária da configuração AWS SDK, recompilando a fonte npm intacta a cada avanço; depois a forma de chamada destroy e a recusa restante do consumidor. O último report S3, da fatia anterior, tinha sete diagnósticos e nenhum binário. S3, redwall e daemon redskilled não foram recompilados nesta fatia; nenhuma operação remota ou CRUD foi executada. Depois de gerar o binário S3, a próxima evidência deve ser execução controlada antes de qualquer operação real.

A disciplina TDD guiou três ciclos red-green de divergências reais e o teste público de pacote que encontrou duas omissões de distribuição. O checkpoint separa bytes qualificados, recusas ainda abertas e bloqueios dos gates; não declara TS arbitrário para Rust nem conclusão do Baldim inteiro.
