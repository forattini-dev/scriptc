# Núcleo TypeScript nativo: plano aprovado e execução

## Contrato aprovado

TS primeiro, com inferência antes de restrições do consumidor. Rust é o destino;
não haverá frontend para fontes Rust. JS/JSDoc e declarações existentes podem
contribuir informação, mas declarações não substituem corpos executáveis.
`unknown` com narrowing é válido; `any` não autoriza operações sem representação
nativa demonstrável. A missão usa Rust sem engine e sem fallback silencioso.

Baseline: TypeScript 7.0.2, ECMAScript 2025 e Node 24 como referência de execução,
com versões exatas fixadas nos experimentos. A etapa de novas bibliotecas só
começa depois de fechar o contrato de linguagem; as integrações existentes
continuam cobertas por regressão.

Fora desta versão: eval arbitrário, código produzido por new Function em runtime,
fontes desconhecidas carregadas em execução, WeakRef/finalização observável por
GC, memória compartilhada entre agentes, Intl e extensões legadas. Prototypes,
reflexão e Proxy exigem contratos representáveis no perfil estático. Isso não
equivale a aceitar todo programa aprovado pelo checker TypeScript.

## Ordem de execução e aceite

1. **Validação integral:** corrigir ambiente/cache, helper LLVM ausente e
   expectativas de bigint; obter os gates plain e sanitized verdes sem ocultar
   recusas. Separar resultados Rust nativo, Rust com engine e C/LLVM.
2. **Escala do frontend:** congelar inputs, medir Node + TS7 por fase, explicar a
   variação do grafo e eliminar consultas equivalentes/retenções. Aceite: três
   análises completas do Redcode original, cada uma em até 600 s e pico de até
   6 GiB sob uma CPU; teto de segurança 8 GiB e sem swap. São metas ainda não
   atingidas, não garantias de implementação.
3. **Contratos da IR:** centralizar conversões, identidade, aliasing, ordem e
   avaliação única; validar operações, capturas e serialização. Migrar por
   famílias, sem reescrita integral.
4. **Linguagem:** tipos/narrowing; valores/coerções; objetos/funções;
   classes/módulos; controle/suspensão; primitivas padrão. Cada família precisa
   de testes positivos, negativos e de interação antes de ser concluída.
5. **Conformidade:** matriz executável separada das APIs Node/Bun, testes
   TypeScript/Test262 com revisões fixadas e licenças, geração determinística e
   redução de divergências. Recusas e exclusões permanecem no relatório.
6. **Otimizações:** constantes/DCE, especialização, intervalos, escape,
   empréstimos de buffers, boxing e dispatch, preservando efeitos e exceções.
   Comparar com a transformação desligada e com a referência JS.
7. **Liberação para bibliotecas:** todas as capacidades incluídas verificadas,
   corpus e gates verdes, cargo test/Clippy verdes e Redcode analisado até o fim.
   Só então ampliar APIs/adapters exigidos pelos consumidores.

Otimizações usam sidecar e Redwall como controles, com inputs/artefatos fixados,
paridade comportamental antes de performance, e Bun compilado como comparador.
Registrar tempo/RAM da compilação separadamente de tempo/CPU/RAM/tamanho do
executável. Investigar regressões maiores que 5% repetidas em duas sessões.

## Execução iniciada em f7cfe1ed

O estado de partida e os experimentos do Redcode estão em
[cache de diagnósticos e vida útil dos programas](../2026-09-13-dependency-compliance/semantic-diagnostics-cache.md).
Nenhuma build completa do Redcode foi demonstrada neste ciclo.

- A falha `ccache.log` foi reproduzida no teste original. O processo herdava
  `LD_LIBRARY_PATH`; a política de produção desabilita corretamente os caches
  nessa situação. Uma sondagem com warmNativeCaches revelou a recusa do cache;
  removendo somente essa variável, a contraprova passou. A sondagem foi removida.
- A suíte de cache agora isola/restaura essa variável, seguindo o isolamento
  existente de outras condições do teste. A política de produção foi preservada
  e seu contrato ganhou uma verificação explícita para LD_LIBRARY_PATH.
- O frontend já reconhece bigint em todos os backends. C/LLVM o recusam na
  admissão nativa. A expectativa SC2001 era obsoleta; a recusa SC2020 do método
  Buffer.readBigUInt64BE continua obrigatória, verificada nos três backends.
- O helper local foi reconstruído a partir destes fontes com LLVM 22.1.8;
  seu comando version confirmou protocolo 1 e pacote 0.0.36-rust.0. O binário
  gerado não é versionado.
- O Sandbox foi consultado novamente: a sessão Vercel está expirada e o
  preflight terminou por timeout. O gate local usa o fallback documentado.

Logs desta execução: `/tmp/scriptc-core-*.log`. Gates e etapas ainda em execução
não são aprovação de publicação nem evidência de conclusão do plano.

### Primeiro checkpoint: infraestrutura de validação

- Repro original do ccache: falhou; contraprova sem LD_LIBRARY_PATH: passou;
  execução após isolamento definitivo: passou. O isolamento comum foi extraído
  para um helper de testes; o teto de native-toolchain.test.ts caiu 3967 → 3960.
- Diagnósticos finais do fixture @types/node: três testes aprovados (Rust,
  C e LLVM), mantendo todas as recusas de membros não implementados. A primeira
  edição manual do snapshot adicionou um newline terminal; ele foi removido
  para preservar o formato exato do renderer antes da execução final.
- Dois contratos de admissão BigInt e três diferenciais Rust passaram,
  incluindo 3200-native-bigint.ts. Contrato de LD_LIBRARY_PATH aprovado.
- Helper LLVM e runtime-pack Linux x64 foram construídos localmente. O teste
  de fetch com AbortSignal/body passou em Rust e C, inicialmente encontrou
  o runtime-pack ausente em LLVM e passou também em LLVM após gerar o pack.
- Build final do workspace aprovado. Lint completo: zero erros, 3140 avisos
  anteriores; limites congelados respeitados.
- Gate plain inicial: 18 aprovados, dois skips, falha no teste Zig porque
  o shim mise não tinha versão selecionada. Selecionar só a versão continuou
  fora da política de cache (wrapper); usar o binário Zig 0.13.0 diretamente
  no PATH aprovou o teste COFF, sem mudança no código de produção.
- Tentativa sanitized com shim foi interrompida deliberadamente após essa
  contraprova, pois mantinha o ambiente já invalidado. Não é resultado terminal
  da suíte. Gate plain com PATH direto e sem override de loader terminou com
  96 testes aprovados, dois skips e uma falha: SIGBUS do rust-lld no primeiro
  fixture do contrato Rust de process/path. A suíte de toolchain terminou com
  63 aprovados e dois skips. Nenhum gate completo verde foi declarado.

O SIGBUS se repetiu no contrato isolado, mas não ao compilar o mesmo Rust para
`/tmp`. A investigação encontrou `/home` cheio (19 MiB disponíveis), enquanto
`/tmp` estava em outra partição com 17 GiB livres. A execução instrumentada
também retornou ENOSPC. Os temporários em `~/.cache/scriptc-test-tmp` ocupavam
185 GiB. Remover os dois diretórios descartáveis `consolidation-20260910g` e
`consolidation-20260910h` liberou aproximadamente 42 GiB; o contrato original
passou então com seus oito fixtures, sem alteração de emissão ou de linker.
Logs: `/tmp/scriptc-core-process-{recheck,strace,after-space}.log`.

A pedido do mantenedor, foram limpos também os caches Cargo de registry,
target e runtime Rust em `/home`, além de `/opt/cargo-target` (já quase vazio).
A limpeza adicional liberou 3,26 GiB em `/home`, preservando fontes,
configurações, credenciais e toolchains. O runtime terá rebuild frio na próxima
validação. Registro: `/tmp/scriptc-cargo-cleanup-20260913.json`.

As correções deste checkpoint não mudam a emissão Rust nem o runtime das
aplicações. A etapa 1 permanece aberta enquanto os gates não terminarem verdes.

### Segundo checkpoint: retenção após descarte no TS7

O teste de coleta com servidor TS7 real reproduziu retenção de ASTs por
programas já descartados. A correção libera as referências da fachada e, ao
fechar o último projeto de um host compartilhado, limpa o cache de fontes do
cliente TS7. Hosts continuam reutilizáveis e fontes de projetos irmãos vivos
preservam identidade. Evidências e limites do experimento estão em
[retenção de programas descartados](disposed-program-retention.md).

### Terceiro checkpoint: sondagens de tipos

As sondagens descartáveis de atribuição npm agora executam a fase de tipos sem preparar estruturas para lowering. O programa final continua passando pelo preflight completo. O diferencial Rust de dependências transitivas passou, e 82 registros ausentes foram conferidos contra o frontend anterior e acrescentados ao canário. A tentativa g do Redcode ainda terminou por timeout de 600 s, com pico de 6,20 GiB e sem binário. Ver [implementação, validação e limites da medição](type-attribution-probes.md). Os gates completos e as metas de escala continuam abertos.

### Quarto checkpoint: declarações de workspaces e análise completa do Redcode

O checkpoint d108b1a9 corrige raízes de declaração configuradas que npm-static ocultava do checker. O Redcode original passou a concluir a análise: compile() retornou em 155,15 s com 3.087 diagnósticos, sem SC0001 e sem binário. Pico de 7,00 GiB; a meta de 6 GiB e os gates completos continuam abertos. Os erros de lowering e dependências agora têm uma captura terminal para triagem. Ver [causa, regressões e medições](type-attribution-probes.md#redcode-original-após-a-correção-das-raízes).

### Quinto checkpoint: conversões de erro no backend Rust

String, interpolação e concatenação dinâmica agora preservam a formatação builtin dos erros e respeitam métodos de conversão próprios. Quatro diferenciais focados passaram em plain e na configuração sanitized, exigindo Rust sem engine e sem runtime fences. Ver [causa, testes e limite seguinte de chaves computadas](rust-error-coercion.md). Esse passo corrige o backend e conserva os programas consumidores.

A seleção Rust ampliada terminou com 112 testes aprovados e uma falha preexistente em chaves computadas (corpus 1703). Os gates gerais plain e sanitized encerraram na mesma falha, com 100 e 69 aprovados, respectivamente; ambos continuam vermelhos. A etapa seguinte deve corrigir a conversão de chaves no frontend, preservando símbolos e ordem de avaliação, antes de ampliar bibliotecas.
