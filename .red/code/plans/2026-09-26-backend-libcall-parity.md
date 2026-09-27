# Fechar as libcalls pós-merge no backend Rust

## Objetivo

Implementar no backend e runtime Rust as 52 libcalls reveladas pela integração do upstream. O desenvolvimento próprio do fork acontece somente na lane Rust: C e LLVM são espelhos do que a Vercel mantém em `upstream/main` e entram apenas por sincronização fiel. Ao final, cada uma das 52 chamadas deve ter lowering Rust memory-safe, o runtime continua `#![forbid(unsafe_code)]` e os programas diferenciais Rust devem reproduzir stdout, stderr e exit code do Node.

## Diagnóstico confirmado

- `main` e `origin/main` apontam para `ffa87b78` após o fast-forward dos 126 commits da branch de integração.
- `pnpm gen:backend-libcalls --check` encontra exatamente 52 órfãs: `zlib` 8, `crypto` 16, `emitter` 2, `child` 7, `cp` 2, `process` 9 e `writer` 8.
- As 52 aparecem nos emitters C e LLVM de `upstream/main`, mas nenhuma aparece nos emitters correspondentes da `main` integrada. Esse drift fica registrado para a próxima sincronização integral do upstream e não bloqueia a implementação Rust.
- O upstream não possui backend Rust. A implementação Rust deve reutilizar os tipos de IR e as primitivas já presentes em `packages/runtime-rust`, sem transportar ownership, ponteiros ou lifecycle do runtime C.
- As 52 chamadas formam cinco fatias verticais: zlib 8; crypto 16; EventEmitter flexível 2; child stdin + execFile 10; fork/IPC 16.

## Regras de execução

- Trabalhar uma fatia Rust por commit. Depois de cada commit, buscar `origin/main` e reconciliar antes de iniciar a próxima fatia.
- Tratar C e LLVM como código upstream: essas lanes só mudam quando uma sincronização integral trouxer alterações mantidas pela Vercel. O plano atual não porta, reimplementa, otimiza nem corrige código C/LLVM.
- Implementar o runtime Rust com ownership explícito, handles rastreáveis e `#![forbid(unsafe_code)]`. Recursos de processo, hash e writer devem ter estado terminal explícito para impedir uso após digest, end, destroy ou disconnect.
- Durante as cinco ondas de implementação Rust, executar apenas verificações de compilação e geração necessárias para manter o código navegável. Concentrar testes focados, corpus diferencial, sanitização e gates completos na onda final, conforme a decisão do mantenedor.
- Alterar fontes de decisão e manifests de propriedade; regenerar `surface-manifest.json`, compatibilidade Node e `backend-libcalls.ts`. Não editar artefatos gerados à mão.

## Limite de escopo — C e LLVM

Não alterar os emitters ou runtimes C/LLVM neste plano. A ausência atual das 52 chamadas nessas lanes é evidência de drift da integração, não um backlog de implementação do fork. Quando ocorrer a próxima sincronização integral, aceitar as implementações mantidas em `upstream/main` e resolver somente conflitos indispensáveis para preservar a lane Rust.

Este limite está respeitado quando o diff produzido pelas ondas abaixo não tocar `packages/compiler/src/backend/c`, `packages/compiler/src/backend/llvm` nem `packages/runtime` por causa dessas 52 chamadas.

## Onda 1 — zlib Rust (8)

Implementar `zlib.crc32` sobre `flate2::Crc` e adaptar as sete operações callback para os codecs síncronos já existentes. A chamada deve validar argumentos de forma síncrona, capturar falhas do codec como `JsError` para o primeiro argumento do callback e agendar exatamente uma conclusão no loop de tarefas, sem transformar uma API callback em Promise.

Chamadas: `zlib.crc32`, `zlib.deflateCb`, `zlib.deflateRawCb`, `zlib.gunzipCb`, `zlib.gzipCb`, `zlib.inflateCb`, `zlib.inflateRawCb`, `zlib.unzipCb`.

Arquivos esperados: `packages/compiler/src/backend/rust/zlib.ts`, helpers de callback/emissão Rust e `packages/runtime-rust/src/zlib.rs`.

Concluído quando as oito chamadas tiverem lowering Rust com shapes validados, nenhum caminho puder disparar o callback duas vezes e `cargo check` do runtime mais o build do compiler passarem.

## Onda 2 — crypto Rust (16)

Adicionar handles Rust próprios para Hash e Hmac incrementais, com clone independente para `hash.copy()`, updates de string/bytes e digest terminal em string ou Buffer. Reutilizar as tabelas de algoritmos já centralizadas em `crypto.rs`. Implementar PBKDF2 via primitivas criptográficas auditadas já disponíveis ou uma dependência Rust segura e fixada; implementar `randomFill`/`randomInt` sobre `getrandom`, respeitando offsets, limites, rejection sampling e erros observáveis do Node. A variante callback deve usar o mesmo núcleo síncrono e a fila assíncrona compartilhada.

Chamadas: `crypto.hashCopy`, `crypto.hashDigestBuffer`, `crypto.hashDigestString`, `crypto.hashNew`, `crypto.hashUpdateBytes`, `crypto.hashUpdateStr`, `crypto.hmacDigestBuffer`, `crypto.hmacDigestString`, `crypto.hmacNewBytes`, `crypto.hmacNewStr`, `crypto.hmacUpdateBytes`, `crypto.hmacUpdateStr`, `crypto.pbkdf2`, `crypto.randomFill`, `crypto.randomFillRest`, `crypto.randomInt`.

Arquivos esperados: `packages/compiler/src/backend/rust/crypto.ts`, representação dos tipos `cryptoHash`/`cryptoHmac` no emitter Rust, `packages/runtime-rust/src/crypto.rs`, `Cargo.toml` e lockfile apenas se uma primitiva segura nova for necessária.

Concluído quando os estados incremental e terminal forem representados sem `unsafe`, cópias não compartilharem mutação acidental, intervalos aleatórios não tiverem viés modular e as 16 chamadas compilarem na lane Rust.

## Onda 3 — EventEmitter flexível (2)

Estender o emitter Rust existente para listener e emissão com payloads `checked-dynamic`, mantendo ordem, listeners `once`, remoção durante emissão, identidade da função, tracing e o comportamento especial de `error`. Reutilizar o registry existente em vez de criar um segundo sistema de eventos.

Chamadas: `emitter.onFlex`, `emitter.emitFlex`.

Arquivos esperados: `packages/compiler/src/backend/rust/event-emitter.ts` e, somente se a abstração atual não bastar, `packages/runtime-rust/src/event_emitter.rs`.

Concluído quando as duas chamadas usarem o mesmo snapshot/lifecycle das variantes tipadas, payloads dinâmicos forem convertidos na fronteira uma única vez e o emitter continuar rastreável pelo coletor.

## Onda 4 — child stdin e execFile (10)

Criar o handle `childWriter` Rust como dono compartilhado do stdin do processo filho, com estados open, ending, finished, destroyed e erro. Implementar write de string/bytes, backpressure, `drain`, `finish`, `error`, end e destroy com callbacks de disparo único. Implementar `cp.execFile` sobre o supervisor de processos existente, preservando arrays de argumentos sem shell, captura de stdout/stderr, erro de spawn e conclusão assíncrona.

Chamadas: `child.stdin`, `writer.destroy`, `writer.end`, `writer.onDrain`, `writer.onError`, `writer.onFinish`, `writer.writable`, `writer.writeBytes`, `writer.writeString`, `cp.execFile`.

Arquivos esperados: `packages/compiler/src/backend/rust/child-process.ts`, representação de `childWriter` no emitter e módulos `child_process*` do runtime Rust.

Concluído quando nenhum write puder ocorrer depois do estado terminal, callbacks mantiverem suas capturas vivas e rastreáveis, fechamento de stdin não bloquear o processo e as dez chamadas compilarem na lane Rust.

## Onda 5 — fork e IPC (16)

Implementar `cp.fork` como execução do módulo compilado indicado por `process.forkTarget`, com um canal IPC framing-delimitado e serialização compatível com o subconjunto estático aceito pelo frontend. Modelar conexão e desconexão uma única vez em ambos os lados; ordenar mensagens por remetente; propagar EOF; e manter callbacks de `send`, `message` e `disconnect` vivos até dispararem ou o canal terminar. `process.currentExitCode` e `process.setExitCode` devem compartilhar a mesma fonte de verdade já usada por `process.exitCodeSet` e pelo encerramento do runtime.

Chamadas: `cp.fork`, `child.connected`, `child.disconnect`, `child.onDisconnect`, `child.onMessage`, `child.send`, `child.sendCb`, `process.connected`, `process.currentExitCode`, `process.disconnect`, `process.forkTarget`, `process.onDisconnect`, `process.onMessage`, `process.send`, `process.sendCb`, `process.setExitCode`.

Arquivos esperados: `packages/compiler/src/backend/rust/child-process.ts`, `process.ts`, suporte de callback/closure do emitter, módulos `child_process*` e process do runtime Rust, além do bootstrap do executável se o fork target precisar ser injetado na inicialização.

Concluído quando parent e child distinguirem ausência de IPC de canal desconectado, send callbacks concluírem uma vez, EOF não perder mensagens já enquadradas, o exit code tiver uma única fonte de verdade e as 16 chamadas compilarem na lane Rust.

## Onda 6 — Regeneração e validação final

1. Regenerar `backend-libcalls.ts` e exigir que as 52 linhas incluam `rust`; não fabricar colunas C/LLVM para completar a tabela.
2. Rodar `pnpm manifest` quando as tabelas de decisão do compiler mudarem e então `pnpm node-compat`; inspecionar o ledger interno, o artefato público e o backlog por mudanças não relacionadas.
3. Adicionar ou completar corpus diferencial por família. Cobrir sucesso, shapes importantes de erro, callback único, ordem/lifecycle, stdout, stderr e exit code. IPC precisa de fixtures parent/worker e crypto aleatório precisa testar invariantes, não bytes específicos.
4. Rodar testes focados por família sob `pnpm limit`, depois `cargo test` e `cargo clippy -- -D warnings` no runtime Rust, `pnpm node-compat:check`, build do workspace e gate de docs se artefatos públicos mudarem.
5. Rodar `pnpm test:sandbox`. Se credenciais Sandbox não existirem, rodar as lanes locais plain e sanitizada prescritas em `AGENTS.md`. Registrar separadamente qualquer limitação real do host para LLVM 22; não classificar ausência de toolchain como regressão de código.

Concluído quando o gerador não tiver órfãs, as 52 chamadas tiverem lowering Rust, o diff da implementação permanecer fora das lanes C/LLVM, os artefatos gerados estiverem limpos, o runtime Rust continuar sem `unsafe`, todos os gates disponíveis estiverem verdes e `git status` estiver limpo.

## Ordem de checkpoints

1. Implementar zlib Rust.
2. Implementar crypto Rust.
3. Implementar EventEmitter flexível Rust.
4. Implementar child stdin + execFile Rust.
5. Implementar fork/IPC Rust.
6. Regenerar, escrever a evidência diferencial Rust e executar todos os testes.

Cada checkpoint termina com commit, `git fetch origin main`, reconciliação explícita e push. Todo o trabalho de produto acontece em Rust, da menor para a maior dependência de lifecycle, deixando a suíte pesada para o final sem acumular tudo em um único commit irrecuperável.
