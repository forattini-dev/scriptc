# Consulta de undefined sem efeitos no lowering

Em 2026-09-09, o gate completo C parou no corpus existente
`2003-generic-methods-object-literal.ts` com `generic function values need
--backend rust`. O mesmo erro foi reproduzido novamente antes desta correção.

`lowerOptionalRecordField` consulta `wrappedUndefined` para verificar se um campo
pode estar ausente. Essa consulta chamava `coerceToExpected`, que sintetizava
helpers de TypeError ao receber tipos não anuláveis. A consulta então descartava
a expressão, mas mantinha os helpers no módulo. No caso 2003, dois helpers
`%unit.strand` retornavam genericFunc sem ter referências na IR. C tentava emitir
suas assinaturas e falhava mesmo que o programa usasse apenas métodos genéricos
especializados estaticamente, já suportados.

A consulta agora verifica diretamente a presença do braço undefined na união e
constrói somente esse unionWrap. Declinar não chama a conversão geral nem cria
funções. O helper foi extraído para `lower-undefined.ts`, com dependência restrita
à consulta `armTag`; a dívida congelada de `lower-calls.ts` foi reduzida em 9 linhas.
Não foram alterados o suporte C a famílias genéricas, o corpus, ou critérios do gate.

Validação:

- Build do workspace passou.
- Corpus 2003 reproduziu o erro antes da correção.
- 10 testes Rust/LLVM passaram; o harness LLVM também executou C contra Node.
- 4 testes C/LLVM sanitizados passaram.
- Controles: parâmetros opcionais 405, campos opcionais 904, famílias 2986,
  flags opcionais 3082 e guardas JSDoc 3143.
- Artefatos gerados do caso 2003 foram preservados, sem os helpers de erro genérico.
- Gate completo ainda pendente; testes focados não constituem aprovação global.

Evidências: `/tmp/scriptc-undefined-probe-20260909/`, incluindo `red.log`,
`green.log`, `sanitized.log`, `build.log`, `lint.log` e `generated/`.
A otimização de compressão e sua comparação C/LLVM/Rust/Bun permanecem documentadas
em `redwall-zlib-borrowed-input.md` como um checkpoint medido separadamente.
