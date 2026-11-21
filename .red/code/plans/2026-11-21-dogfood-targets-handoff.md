# Handoff: compilar os projetos termômetro com o driver Rust nativo

Checkpoint de 2026-11-21 para que outro agente retome a partir de `main`. A meta do mantenedor é compilar com sucesso, pelo driver nativo (`packages/compiler-rust`, `--no-engine`, sem fallback), projetos reais e complexos: recker, raffel, red-dev, redskilled, red-skills e redcode (brain e rsp também vêm sendo usados como termômetros). A meta não está concluída. Este commit é um checkpoint de desenvolvimento, não uma release validada: as duas lanes completas (`pnpm test` plain e `SCRIPTC_SAN=1`) não foram executadas nesta etapa porque o pnpm não estava disponível no host Windows. A primeira tarefa da retomada é rodar as duas lanes em sequência, sem sobreposição, e corrigir o que falhar antes de qualquer outro passo.

## Estado por projeto

<table>
<thead><tr><th>Projeto</th><th>Estado</th><th>Próxima barreira</th></tr></thead>
<tbody>
<tr><td>redskilled</td><td>Binário nativo compilado e verificado.</td><td>Manter como regressão.</td></tr>
<tr><td>recker</td><td>O probe da CLI avança por ws WebSocketServer, ClientAIImpl, o LRUCache do template engine, `timer.unref` do socks e `new WebSocketCtor`.</td><td>A última barreira registrada, `fs.createWriteStream(path)` com um argumento em `src/protocols/ftp.ts:8086`, foi corrigida (operação `fs.createWriteStreamPath`), mas o probe não foi reexecutado depois da correção porque o processo anterior foi encerrado por falta de memória.</td></tr>
<tr><td>red-dev, rsp</td><td>IR gerado; nenhum binário.</td><td>O build de binário exige cerca de 5 GB de disco por alvo; aguarda decisão do mantenedor.</td></tr>
<tr><td>raffel</td><td>Bloqueado.</td><td>`worker_threads` e `FinalizationRegistry`; a política para `worker_threads` aguarda decisão do mantenedor.</td></tr>
<tr><td>red-skills</td><td>Bloqueado.</td><td>Módulo `Document.js` do pacote yaml.</td></tr>
<tr><td>brain</td><td>Bloqueado.</td><td>ajv gera validadores com `new Function`; aguarda decisão do mantenedor.</td></tr>
<tr><td>redcode</td><td>Bloqueado.</td><td>Herança de classes dinâmicas do Effect.</td></tr>
</tbody>
</table>

A política escolhida pelo mantenedor é portar cada API de verdade: manter as recusas em tempo de compilação para formas ainda não portadas e nunca introduzir stubs de runtime. Cada correção entra com um fixture diferencial que roda sob Node e como binário compilado, com stdout, stderr e exit code idênticos byte a byte. Não há regra por nome de pacote ou caminho de consumidor.

## Como reproduzir

Os checkouts usados nesta máquina estão em `C:/Users/filip/dev/scriptc-targets/recker` (commit 8501b56) e `C:/Users/filip/dev/scriptc-targets/raffel`; redskilled, red-dev e red-skills estão sob `C:/Users/filip/Documents/Codex/2026-10-13/clo/work/github-targets/`; redcode em `C:/Users/filip/Work/redcode`. Em outra máquina, clone os repositórios equivalentes.

O probe do recker gera só IR, que é suficiente para encontrar a próxima barreira do frontend:

```console
$ cd <recker>
$ <scriptc>/packages/compiler-rust/target/debug/scriptc build src/cli/index.ts --no-engine --emit ir --out <scratch>/recker-cli.ir.json
```

A saída de erro aponta a próxima recusa (`SCN1001 ... native library overload is not ported`, etc.). Reduza a recusa a um fixture mínimo em `tests/corpus/rust-native-<família>/`, registre-o em `packages/compiler-rust/tests/native.rs` e confira a paridade com `packages/compiler-rust/tools/native-parity.sh <fixture>` usando `NODE` apontando para o Node 24 pinado.

Os recursos da máquina são limitados: rode uma tarefa pesada por vez, use `CARGO_BUILD_JOBS=1` (o script de paridade já define isso) e monitore a RAM livre antes de iniciar o probe do recker, que já foi encerrado por falta de memória.

## Mudanças desta etapa

O checkpoint inclui o trabalho acumulado de várias sessões no driver nativo e no runtime Rust, além de cerca de 790 diretórios novos de corpus e fixtures. As correções mais recentes, motivadas pelo recker:

- `fs.createWriteStream(path)` com um argumento ganhou a operação `fs.createWriteStreamPath`; o stream aceita chunks string, `end(chunk[, cb])` e opções string. Fixture `tests/corpus/rust-native-write-stream-default/main.cjs`.
- Classes que implementam interfaces e tipos construtores (`new (...) => T`) entram no inventário `data_types` antes do planejamento de layout, para que valores mantenham a representação proprietária. Fixtures `rust-native-interface-field-class-instance` e `rust-native-constructor-type-value`.
- A construção dinâmica compara classes por layout (`dyn.classLayoutIs`) em vez de identidade, o que cobre expressões de classe criadas em runtime.
- Métodos de EventEmitter lidos como valor (`emit.bind`, `on` passado como callback) usam a variante `EmitterMethod`. Fixture `rust-native-listener-arity-union`.
- Servidores HTTP vistos por JavaScript apagado (ws, frameworks) usam `http_server_support.rs`. Fixture `rust-native-http-server`.
- Timers lidos em posição de condição (`timer.unref && timer.unref()`) resolvem para verdadeiro. Fixture `rust-native-timer-method-probe`.

Os testes unitários do crate passaram (178 aprovados, 2 ignorados), `node src/generate.mjs --check-local` em `internal/compatibility` confirmou o snapshot local, e os fixtures de regressão acima conferiram com o Node. Nenhum arquivo gerado foi editado à mão.

## Higiene do checkout

Os artefatos de probe dos agentes (`.codex-*` em qualquer diretório, IR, Rust emitido, binários e saídas capturadas) e os repros em `packages/compiler-rust/targets/` passaram a ser ignorados pelo `.gitignore`; nada foi apagado, para preservar o trabalho de outros agentes no mesmo checkout. Os três inventários de reddb já versionados em `targets/` continuam rastreados.
