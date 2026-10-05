# Promisify zlib nativo em Rust

Em 2026-10-03, a primeira fatia do checkpoint Node 26 foi implementada: projeções nativas de `util.promisify(deflateRaw)` e `util.promisify(inflateRaw)`, sem engine JS, FFI externa ou nightly Rust. Os testes focados passaram nos dois majors, e as duas recusas de promisify desapareceram do build original do Baldim S3. Isso não estabelece TS arbitrário para Rust nem o build completo do Baldim: o S3 ainda tem sete diagnósticos, o consumidor original de compressão tem sete recusas e os bytes do compressor Rust divergem do Node em vetores maiores.

## Escopo implementado

O frontend registra const bindings de named imports de `util`/`node:util` e `zlib`/`node:zlib`; chamadas diretas baixam para as novas libcalls de promises. Entradas string são convertidas para UTF-8 pelo caminho existente de zlib; Buffer/Uint8Array usam o mesmo caminho de bytes. `deflateRaw` admite opções omitidas ou o literal `{ level }`, inclusive com um valor de nível calculado em runtime. `inflateRaw` admite um argumento. O runtime valida o nível dentro de uma promise e reutiliza o codec callback existente para manter conclusão adiada, em vez de envolver um codec síncrono em uma promise já resolvida.

Os testes cobrem níveis 0, 6 e 9 em vetores pequenos, bytes comprimidos e restaurados, strings UTF-8, ordem em relação à microtask, rejeições de níveis inválidos e dados corrompidos, stdout/stderr/status/sinal e auditoria de heap. Opções diferentes de `{ level }`, mutable bindings, escapar a função como valor e promisify de outros codecs continuam com recusas explícitas. Arbitrary callbacks, custom promisify hooks, aliases de targets e opções completas de zlib não foram implementados por esta fatia. As projeções novas são Rust-only; não se afirma suporte C/LLVM por terem sido admitidas pelo frontend.

As fontes novas centrais são `packages/compiler/src/frontend/lowering/lower-promisify-zlib.ts`, `packages/compiler/src/backend/rust/zlib.ts` e `packages/runtime-rust/src/zlib.rs`. O gate focado é `packages/compiler/test/promisify-zlib.test.ts`, com quatro programas diferenciais em `tests/corpus/3393` a `3396` e fixtures específicas de recusa/interoperabilidade. O CI existente de foco 26 e regressão 24 agora inclui esse arquivo; o workflow não foi executado no GitHub neste ambiente.

## Evidência local

- Node 26.10.0, alvo `node26`: 13 testes passaram em 81,681 segundos, com binários dev/release nos quatro casos diferenciais, quatro recusas e um teste explícito da divergência/interoperabilidade. A duração total do runner foi 89,08 segundos.
- Node 24.15.0, alvo `node24`: os mesmos 13 testes passaram em 102,835 segundos; duração total de 110,77 segundos.
- Os programas antigos `1404-zlib-crypto-bytes.ts`, `2825-zlib-gzip-oneshot.ts` e `2921-zlib-callbacks.ts` compilaram para Rust/node26 e passaram em comparação de stdout, stderr, status e sinal contra Node 26.10.0, sem engine e com auditoria de heap. A execução usou o harness de stdio em arquivos, sem alterar os testes antigos.
- TypeScript do compiler, ESLint dos arquivos novos e da emissão zlib, build recursivo do workspace, quatro testes focados de zlib no runtime, três testes de file-stdio e Cargo clippy com `--all-targets --locked -- -D warnings` passaram.
- `surface-manifest.json` e a tabela de backend libcalls foram regenerados pelos scripts do projeto. O check da tabela está atual com 1297 spellings; esse total inclui WIP anterior e não mede a contribuição isolada desta fatia.
- `pnpm node-compat --offline` e `pnpm node-compat:check` passaram. Os novos testes foram associados apenas a util.promisify e aos callbacks raw, com prefixos mais específicos para evitar contaminar evidências de outros métodos. Os status continuam `partial`; o artefato público e o registry dinâmico permaneceram iguais ao HEAD. Não houve hand-edit de arquivos gerados.

O pin técnico de `node26` e do CI continua 26.8.1; o executável local disponível é 26.10.0. A evidência local do 26 é exploratória, não execução do pin. O pin 24.15.0 foi executado. Não foram trocados o primary da matriz, `.node-version` nem o denominador público Node 24. A orientação permanece Node 26 como prioridade, Node 24 como compatibilidade e Rust stable.

## Divergência de compressão medida

A sondagem local de cinco textos e onze níveis produziu 55 resultados com round-trip correto, mas onze linhas com bytes comprimidos diferentes do Node 26.10.0. Entre elas estão níveis -1/6 de textos repetidos maiores e nível 1 de um texto curto. Isso reforça o limite preexistente do codec zlib-rs: usar o mesmo nível numérico e produzir DEFLATE válido não garante o algoritmo nem os bytes exatos de Node.

O caso permanente usa `"hello ☃".repeat(64)` no nível 6. Node produz base64 `y0jNyclXeDSjOWOUMcognQEA`; o Rust atual produz `y0jNyclXeDSjOWOUMRoI+SSnBAA=`. O teste registra ambos os resultados, verifica que Rust decodifica os bytes do Node e que Node decodifica os bytes do Rust. Ele é uma prova de interoperabilidade e uma regressão da limitação documentada, não um teste de paridade exata aprovado. Os quatro programas diferenciais permanecem estritos, sem trocar igualdade de bytes por round-trip para fazê-los passar.

`docs/src/app/limitations/page.mdx` agora explica separadamente a projeção limitada de promisify e a não identidade universal dos bytes de compressão. Alinhar o algoritmo Rust aos bytes do Node continua trabalho necessário para consumidores que publicam, comparam ou fazem hash de resultados comprimidos, incluindo a qualificação estrita do Baldim e do renderer PNG.

## Probes originais do Baldim

O `@baldim/core` instalado permanece 0.2.1, sem patches nas fontes npm. A análise isolada de `dist/concerns/text-compression.js` termina sem diagnóstico nem falha de preflight; seu SHA-256 atual é `1e5587720d1878156dc5f2b4216e31bda2026df4d6832c31c3a2a9812ae56e14`. Essa análise demonstra admissão do módulo, não execução de suas funções exportadas.

O consumidor `core-compression.ts` importa `compressTextAsync`/`decompressTextAsync` pelo subpath público original. O último build Rust/node26 falhou em 1,374 segundos, com RSS máximo de 313556 KiB, sem binário. O relatório está em `.red/tmp/baldim-rust-20261001-nDbseO/results/core-compression-promisify-final-20261003/probe.json`. Há sete SC3003: um `Buffer.from` com valor dinâmico, dois arrays `any[]` no encoder Base85, três escritas que herdam a representação inválida desses arrays e um SC2004 derivado do binding `chars`. São famílias coerentes, não sete funcionalidades independentes.

O build do consumidor S3 original caiu de nove para sete diagnósticos em 86,667 segundos, com RSS máximo de 687920 KiB; não gerou binário. O relatório, criado em 2026-10-03 UTC, está em `.red/tmp/baldim-rust-20261001-nDbseO/results/s3-client-promisify-progress-20261002/probe.json`. Restam quatro SC2013 de pino/recker, um SC2011 no consumidor, um SC1090 em `client.destroy` e um SC2004 de `_config_0` no AWS SDK. A recusa derivada de `_config_0` exige descobrir o blocker original da configuração, não aceitar silenciosamente seu uso. Não houve CRUD nem acesso remoto a S3.

## Gates ainda bloqueados

O build recursivo passou depois da regeneração de compatibilidade; a primeira tentativa havia recusado corretamente o ledger desatualizado. Isso não recompila os artefatos nativos empacotados.

A tentativa da lane plain, com um worker e bail no primeiro erro, falhou no `001-hello.ts`: o binário imprimiu `hello world`, enquanto a captura por pipe do oráculo retornou vazia neste sandbox. A lane sanitized, também com bail, falhou no teste de invalidação de artefatos nativos com `spawnSync ... EPERM`, depois de quatro testes aprovados. Nenhuma lane completa está qualificada. Não foram desativados asserts, sanitizers ou contratos para obter um gate verde.

O Cargo test completo coletou 272 testes, mas apresentou falhas nas famílias de rede e terminou anormalmente no grupo UDP. A sondagem independente de um listen em loopback também retornou `EPERM` neste ambiente. O gate completo do runtime não passou; clippy e testes focados não o substituem.

O gate dos docs `NEXT_DIST_DIR=.next-check pnpm check` não conseguiu iniciar: a identidade assinada do pnpm 10.23.0 não pôde ser verificada no registry pela rede restrita. A verificação não foi desativada. O check global de limites de arquivos também segue vermelho nos ceilings existentes, incluindo alguns arquivos tocados por este e por trabalhos anteriores; os limites não foram elevados.

O limitador por cgroup continua indisponível por acesso negado ao user bus. Foram mantidos um worker de testes por comando, um job Cargo/nativo e heap Node de 1,5 GiB; esses limites não equivalem a um teto rígido de RAM da máquina. A observação local de memória indicou cerca de 16 GiB disponíveis, sem pressão aparente; a lista de processos é limitada pelo namespace do sandbox.

`git fetch origin main` foi tentado novamente e recusado porque `.git/FETCH_HEAD` está somente leitura. Não houve reconciliação, commit nem push, e o WIP anterior foi preservado. Esses bloqueios permanecem pendentes antes de shipping.

## Próximas fatias

1. Implementar `Buffer.from` com entrada dinâmica no Rust, minimizando a chamada original de text-compression e qualificando coerções, encodings e erros contra Node 26 antes de repetir no 24. Não substituir a fonte npm por uma variante tipada para declarar sucesso.
2. Dar representação nativa aos arrays JavaScript esparsos usados pelo Base85: comprimento inicial, buracos, crescimento, escrita de strings e join. Cobrir a composição em fixture mínima e então repetir o consumidor original até produzir um binário com paridade de seus encodings e caminhos de threshold.
3. Resolver a paridade de bytes do compressor como uma tarefa explícita, com vetores maiores e níveis múltiplos. Decodificação correta e igualdade de pixels PNG não fecham esse critério.
4. Minimizar a declaração de configuração do AWS SDK, investigar o motivo real de pino/recker permanecerem imports de island e tratar essas famílias no compilador. Repetir o S3 original após cada fatia, sem suprimir recusas de no-engine nem alterar o pacote.
5. Executar ambos os gates completos e os docs no ambiente que permita os contratos nativos, rede local e package-manager identity, reconciliar origin/main e só então preparar shipping. Os testes atuais comprovam a projeção limitada e identificam os próximos blockers; não autorizam afirmar TS para Rust total.

A skill TDD orientou os testes públicos fonte → compilação → binário → Node, com casos vermelhos antes das implementações e separação explícita da divergência de compressão. A skill de serialização preservou os contratos existentes, sem introduzir um novo formato de persistência ou wire. Este checkpoint mantém o destino documental local do projeto.
