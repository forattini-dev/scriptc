# Entradas sem extensão: reproducer do crash TS7 (2026-09-09)

A auditoria do lançador `redcode/packages/redcode/bin/redcode` continua
reproduzindo `panic: ScriptKind must be specified`, seguido de EOF do RPC.
Uma sonda que chama somente `Ts7Host.createProgram` também reproduz a falha;
não precisa emitir IR, gerar Rust, compilar dependências ou executar o lançador.
Um overlay em memória substituindo o conteúdo do lançador por duas linhas
preserva o crash, sem escrever no consumidor.

O exemplo reduzido é um arquivo `solo`, sem extensão e sem vizinhos `solo.js`
ou `solo.ts`, com os seguintes bytes:

```js
#!/usr/bin/env node
console.log("extensionless", 6 * 7);
```

Opções: `{ allowJs: true, checkJs: true, noEmit: true }`. A criação do projeto
com esse root derruba o processo TS7. A presença de um arquivo `.js` com o
mesmo nome-base muda a resolução:

| Caso controlado | Resultado |
|---|---|
| `solo`, sem arquivo `.js` vizinho | panic durante createProgram; EOF no cliente |
| `solo`, com `solo.js` contendo texto diferente | sem panic; `getSourceFile(solo)` ausente; o programa carrega `solo.js` |
| root explicitamente `solo.js` | fonte solicitado carregado corretamente |

O contraste é importante: saída zero de uma sonda do host não prova que a
entrada solicitada foi carregada. A API completa `analyze` recusa o primeiro
exemplo com vizinho usando `could not load`; não houve emissão de um binário
para o arquivo errado nessa sonda. O controle registra o texto diferente
`console.log("different sibling")` efetivamente carregado pelo checker.

A hipótese intermediária sobre pontos nos nomes dos diretórios foi descartada:
diretórios com e sem pontos reproduzem o panic. O primeiro controle aparentemente
estável tinha, por construção, o arquivo `.js` vizinho. A matriz posterior
adicionou o vizinho somente depois de observar a falha, isolando essa diferença.

Esta etapa apenas minimiza o defeito. Uma correção ainda precisa admitir a
linguagem preservando identidade de arquivo/imports, ou produzir diagnóstico
controlado antes da falha do servidor. Não se deve renomear entradas do
consumidor, escolher silenciosamente arquivos vizinhos ou tratar EOF como
diagnóstico de tipagem. Também é necessário proteger a continuidade de hosts
compartilhados depois de uma entrada inválida. O suporte a lançadores não
constitui a compilação das aplicações que eles iniciam.

As sondas executam no limitador de recursos e preservam os fontes dos
consumidores. Nenhuma correção de frontend foi aplicada nesta investigação.
Scripts, matrizes, opções reais, logs e recibos estão em
`.red/tmp/native-extensionless-investigation-20260909/`.
