# Guardas de ausência em records JSDoc

O gate completo encontrou uma divergência em `1593-js-jsdoc-records.js`:
`strings.missing === undefined` imprimia `false` nos três backends, enquanto
Node imprimia `true`. O acesso equivalente por colchetes estava correto.
A execução plain terminou com 264 testes aprovados e uma falha; a etapa
sanitizada e o benchmark encadeado não foram iniciados.

## Causa e correção

`fieldTarget` passou a consultar o shape do valor realmente armazenado para
acessos ao overflow de records. Essa consulta exigia um receptor `record` e
descartava globais JavaScript com anotação JSDoc cuja representação é `dyn`.
Sem o target, a guarda perdia a leitura que preserva `undefined`, e a comparação
era reduzida a uma constante usando o tipo declarado `string`.

A correção mantém o target dinâmico antes da consulta ao shape nativo. Os
leitores e escritores já sabem despachar esse target para a árvore dinâmica;
records nativos continuam usando o shape de seu armazenamento real.

O novo corpus revelou também que a negação `!strings.missing` validava a chave
ausente como string e lançava erro. A negação agora usa `lowerCondition`, como
as demais condições booleanas, preservando ausência antes de aplicar ToBoolean.
Leituras comuns que exigem um valor tipado continuam com sua validação.

## Evidência

- Reprodução isolada de 1593 falhou em Rust e no diferencial C/LLVM.
- O novo `3143-jsdoc-dynamic-absence.js`, com `@no-engine`, falhou antes da
  correção. Cobre dot/bracket, comparação invertida, igualdade e desigualdade,
  defaults, strings vazias, identidade de objetos, negação, records/arrays
  locais e contagem dos efeitos de avaliação do receptor e da chave.
- Após a correção, 1593, 3143 e o controle nativo 911 passaram em Rust e no
  diferencial C/LLVM: seis testes, incluindo comparação byte a byte com Node.
- Os mesmos três casos passaram no diferencial C/LLVM com sanitizadores.
- O contrato de índices ausentes através de especialização npm passou em
  Rust/C/LLVM na etapa normal e em C/LLVM com sanitizadores: cinco testes.
- Build do workspace, tetos de linhas, artefatos gerados e lint passaram.
  O lint completo reportou zero erros e 3.122 warnings no workspace.

## Redwall após a correção

A nova build passou nos 38 contratos, incluindo 26 renderizações nativas
byte a byte iguais ao Bun. O código Rust gerado, os fontes do consumidor e
o runtime mantêm os hashes da build anterior. Engine `none`, FFI externa
`false`, zero fences e binário de 4.069.616 bytes.

Na rodada com 11 execuções por candidato, um aquecimento, ordem alternada e
afinidade no CPU 2, todas as 24 saídas foram idênticas. Rust venceu 9/11 pares:

| Mediana | Rust | Bun compilado |
| --- | ---: | ---: |
| Tempo | 901,30 ms | 936,89 ms |
| CPU usuário + sistema | 0,89 s | 0,92 s |
| Pico RSS | 111.164 KiB | 144.516 KiB |
| Binário, sem assets externos | 4.069.616 bytes | 81.413.600 bytes |

São 3,8% menos tempo nesta rodada. A máquina é compartilhada e as tarefas de
build/teste deste trabalho terminaram antes da medição. A diferença para
rodadas anteriores não pode ser atribuída a esta correção: o Rust gerado é
idêntico. O workload continua sendo o renderer original pelo adapter de
contratos, sem representar todas as operações da CLI.

Não há alteração no consumidor, nas flags de otimização ou no runtime. O gate
plain/sanitizado completo permanece obrigatório antes de concluir a missão.
Evidências: `/tmp/scriptc-jsdoc-missing-20260909/`.
