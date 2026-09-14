# TS7: liberação de ASTs após descarte

## Defeito e contrato

O ciclo de atribuição de erros npm mantém o objeto do load anterior enquanto
experimenta conjuntos de pacotes. Mesmo depois de dispose(), esse objeto
retinha sourceFilesCache e checkerFacade. A fachada do checker também pode
reter ASTs materializadas. No host compartilhado há outra referência: o
cliente TS7 conserva o cache de fontes do último snapshot para reutilização,
mesmo depois de descartar esse snapshot.

Ts7Program.dispose() agora limpa suas referências de fontes e checker, além
dos diagnósticos semânticos. Ts7Host.releaseProgram() limpa o cache de fontes
da API somente quando o snapshot atualizado não tem projetos abertos. Essa
condição conserva a identidade e reutilização de fontes de programas irmãos
vivos; o host permanece disponível para uma carga posterior.

Os testes novos mantêm o wrapper descartado vivo e verificam WeakRefs para a
AST e para o checker numa subprocesso Node com GC explícito e servidor TS7
real. As duas variantes (host próprio e compartilhado) falharam antes da
correção. Limpar só os campos da fachada resolveu o host próprio, mas deixou
o compartilhado falhando. A limpeza condicional da API resolveu o segundo.
O teste existente de projetos irmãos agora verifica identidade de uma fonte
materializada antes do descarte do outro programa.

## Validação da mudança

- Cinco testes de ciclo de vida/cache passaram na faixa plain e na faixa
  SCRIPTC_SAN=1. Isso não instrumenta o runtime Rust com ASan.
- 29 testes de integração de declarações, aquisição de tipos e fachada TS7
  passaram.
- Build TypeScript do pacote compiler passou, usando metadata incremental
  isolada em /tmp/scriptc-core-retention.tsbuildinfo.
- ESLint dos arquivos modificados, limites de arquivos e git diff --check
  passaram. Nenhum arquivo do runtime Rust foi alterado.
- O contrato diferencial Rust de process/path passou depois de liberar
  espaço em /home; a falha anterior era SIGBUS no linker (ver README).
- Gates completos plain e sanitized continuam pendentes. A execução plain
  encerrada com SIGBUS usava o checkpoint anterior 7ee8ece5.

Logs locais: /tmp/scriptc-core-retention-*.log.

## Redcode original: tentativa f

O consumidor foi mantido no commit
b8fa0e8e31cd6dac384347f4852fc7b3c8519a86, sem alterações. Mesmos 34 pacotes
npm-static explícitos, backend Rust, allowEngine=false, target bun, release.
Limites: uma CPU, MemoryHigh=7G, MemoryMax=8G e sem swap.

Resultado terminal do executor: timeout de 600 s, exit 124; o monitor encerrou
em 606,70 s incluindo término/amostragem. compile() não retornou e nenhum
binário foi produzido. Pico direto do cgroup: 6.974.951.424 bytes (6,50 GiB).
Última amostra: zero eventos high, max, oom e oom_kill. Houve 28 criações de
programas e 14 consultas semânticas registradas; os wrappers incluem consultas
servidas pelo cache e não contam exclusivamente RPCs ao servidor.

Foram conferidos antes/depois os hashes de 484 fontes TS do compiler, 6.848
arquivos versionados do consumidor e 4.223 arquivos do grafo anterior: nenhuma
mudança encontrada. Isso não é um snapshot físico de todas as dependências
instaladas. Artefatos: /tmp/scriptc-redcode-memory-20260913f/{execution.json,
hash-check.json,phases.jsonl,memory.jsonl,build.json}.

A tentativa anterior e também terminou por timeout, com pico 7,34 GiB. Os
picos observados são de execuções incompletas e houve verificações concorrentes
na máquina: não constituem benchmark controlado de ganho percentual nem
evidência de conclusão da análise. O limite de 6 GiB e três análises completas
em até 600 s continua não atendido. A investigação seguinte deve explicar e
reduzir as reanálises da atribuição npm, preservando os diagnósticos.
