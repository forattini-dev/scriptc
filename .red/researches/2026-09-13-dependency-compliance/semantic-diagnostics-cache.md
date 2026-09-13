# Memória da análise do Redcode: diagnósticos por snapshot

Continuação do checkpoint `e50752ff`, mantendo o backend Rust, `allowEngine: false`, alvo Bun, otimização release e a mesma lista explícita de 34 pacotes npm-static. O consumidor é o entrypoint original `redcode/packages/redcode/src/index.ts`, no commit `b8fa0e8e31cd6dac384347f4852fc7b3c8519a86`. Nenhum arquivo do consumidor foi adaptado.

## Causa isolada e correção

A instrumentação da tentativa `/tmp/scriptc-redcode-memory-20260913a` mostrou que a carga, os diagnósticos do programa de lowering, os diagnósticos da visão original do projeto e o prefetch estrutural terminavam. O crescimento que levou o cgroup à pressão de memória ocorreu durante uma nova consulta de diagnósticos semânticos ao mesmo programa. O chamador é a conferência de perda de contexto de callbacks em `npm-static-context.ts`, posterior ao preflight. O programa TS7 é um snapshot imutável, mas a fachada encaminhava cada solicitação ao servidor novamente.

`Ts7Program` agora memoriza os diagnósticos semânticos por instância e por escopo: programa inteiro e cada arquivo são consultas distintas. Não há cache global por filename, redução de regras de validação nem substituição de diagnósticos. Falhas de consulta não são memorizadas; o cache é limpo no descarte do programa.

O teste em `packages/compiler/src/frontend/ts7/program-adapter.test.ts` executa o servidor real. Antes da correção, preflight e dois consumidores posteriores provocavam três chamadas; depois, uma. O teste também confere erros TS7006/TS2322, separação entre arquivos e respostas diferentes para snapshots strict e não strict do mesmo código. O teste preexistente de descarte confere o inventário real dos projetos do servidor.

Uma segunda retenção foi confirmada em `packages/compiler/src/frontend/program.test.ts`: após consultar o programa sem overrides, o inventário do servidor ainda continha os dois projetos. A consulta agora tem escopo de callback (`withProjectWorld`), com descarte em `finally`, antes do prefetch/lowering. O teste falhou antes da mudança e passou depois; também verifica limpeza quando o callback lança e duas chamadas sucessivas de preflight. As respostas continuam sendo os erros originais do projeto. O limite congelado de `program.ts` diminuiu de 3.258 para 3.253 linhas.

## Experimentos

Todas as tentativas usam `CPUQuota=100%`, `MemoryHigh=7G`, `MemoryMax=8G` e `MemorySwapMax=0`. A medição externa lê `memory.current`, `memory.peak`, `memory.events` e `cpu.stat` no cgroup a cada dois segundos. O RSS do Node isolado não é o consumo total: o processo TS7 também está no cgroup. O resumo final do systemd para `e` registra apenas 3,5 MB de pico, incompatível com a série direta de `memory.peak`; esse resumo não foi usado como medição de memória.

- `a`: código anterior com marcadores temporários de etapas. Interrompida deliberadamente depois de identificar a segunda consulta semântica sob pressão de memória; o journal registra pico de 7,3 GiB. Não classificar essa interrupção como OOM automático. As mortes por oomd anteriores estão documentadas no checkpoint de Promise.
- `b`: contraprova temporária, memorizando apenas a consulta semântica global no runner. Passou pela consulta repetida e avançou por novas cargas. Interrompida deliberadamente após isolar o efeito, antes do resultado terminal. Não é uma build concluída.
- `c`: cache implementado, sem a correção de vida útil da visão de tipos. Avançou por quatro cargas. Uma tentativa de inspeção pelo debugger não retornou stack frames; o processo terminou pelo timeout de 600 segundos. O período após essa tentativa é inconclusivo e não sustenta atribuição de travamento ao compilador.
- `d`: repetição do cache, sem debugger. Avançou por novas cargas, mas voltou a apresentar pressão de memória numa etapa posterior. Interrompida deliberadamente para testar a liberação da visão temporária do projeto. Não classificar essa interrupção como OOM nem como build concluída.
- `e`: implementação final, com cache e descarte imediato da visão temporária. Sem debugger. Os wrappers externos apenas registram etapas, arquivos dos programas e os diagnósticos retornados. Código do compilador e hashes do consumidor são capturados para conferência. Resultado: timeout de 600 segundos (exit 124), sem binário e sem retorno terminal de `compile()`. Pico do cgroup: 7.877.447.680 bytes (7,34 GiB); 38.084 eventos de pressão `high`, nenhum evento de OOM/oom_kill na última amostra. Houve 20 criações de programas, incluindo probes de tipos e recriações por roots, ao longo de cinco cargas principais. Medidas em `semantic-diagnostics-cache.json`.

As tentativas interrompidas não permitem comparar tempo total de build nem afirmar uma redução percentual do pico integral. As verificações concorrentes também impedem tratar tempos entre tentativas como benchmark controlado. Este trabalho mede recursos da compilação, não CPU/RAM ou desempenho do binário Redcode.

## Variação do grafo ainda não isolada

As capturas de `c` e `d` diferem em 51 arquivos JS internos de `undici@8.3.0` na primeira carga final: 4.223 contra 4.172 fontes, com os mesmos 19 roots e opções. Os arquivos versionados do consumidor não mudaram. Isso é uma observação sobre o grafo materializado, não prova da causa: os arquivos de dependências não foram todos congelados antes de cada tentativa. A interação entre profundidade de JS (`maxNodeModuleJsDepth=4`), resolução e shadow de tipos precisa de reprodução isolada. Um modelo pequeno de imports diretos e transitivos, limitado à profundidade 2, ficou estável em 30 execuções; portanto, esse modelo não reproduz o problema real e não virou teste de regressão.

## Validação

- Build do workspace aprovada.
- Lint completo: zero erros; o aviso introduzido inicialmente no teste foi removido e os dois arquivos alterados foram revalidados sem avisos. Os avisos anteriores do repositório permanecem.
- Seleção de fachada, ciclo de vida, cache e configuração: 32 testes aprovados e duas falhas. Ambas se reproduzem no baseline isolado `e50752ff`: helper LLVM ausente (`scriptc-llvm-codegen`) e snapshot `node-types-fenced.txt` ainda esperando a recusa SC2001 de bigint. Não houve atualização de snapshot para esconder a diferença.
- Teste final do cache e de ciclo de vida: dois aprovados.
- Aquisição de tipos: dois aprovados, incluindo execução diferencial Rust/Node.
- Depois da liberação da visão temporária: cinco testes focados aprovados (vida útil, cache, descarte de snapshots e as duas variantes JSON.parse de preflight), mais 26 de integração (declarações configuradas, aquisição e fachada TS7). Build e lint completos aprovados novamente, com os mesmos 3.140 avisos anteriores.
- Gates completos locais finais plain e sanitized: ambos pararam em `native-toolchain.test.ts:330`, sem `ccache.log`; seis testes aprovados e um reprovado em cada faixa (execução com `--bail=1`). Ver resultado consolidado no JSON. O fallback local usa a indisponibilidade de acesso Sandbox registrada no checkpoint anterior. Gates vermelhos impedem publicação.

Os marcadores temporários foram removidos do código. Logs, capturas de fontes e séries de memória ficam nos diretórios `/tmp/scriptc-redcode-memory-20260913{a,b,c,d,e}`. O baseline dos testes é `/tmp/scriptc-memory-baseline-20260913`, com arquivos versionados intactos e links de dependências não versionados.

## Próxima investigação

Estabilizar e explicar o grafo de JS de dependências; registrar os diagnósticos que provocam cada rodada de atribuição de erro npm; reduzir reanálises equivalentes sem retirar tipos ou esconder erros. Também verificar retenção de ASTs no Node depois do descarte de programas. O objetivo seguinte continua sendo obter um resultado terminal do entrypoint original com as mesmas restrições Rust/sem engine. A memória integral e a compilação nativa não estão declaradas resolvidas apenas pelos testes das duas correções.
