# Covariância de Promise no backend Rust

Continuação do [checkpoint de regex](regex-stateful-rust.md), sobre o compilador `29101fb7`. A correção pertence ao compilador; os repositórios consumidores não precisam alterar callbacks válidos como `() => Promise<number>` para satisfazer um parâmetro `() => Promise<unknown>`.

## Reprodução e causa

O caso mínimo compilava, mas o binário lançava o erro do adaptador de função ao chamar callbacks que retornavam `Promise<number>` ou `Promise<string>`. Um callback que rejeitava com `original rejection` também perdia sua Promise: além do erro do adaptador, aparecia `UnhandledPromiseRejection`, e o processo terminava com status 1. O Node entregava os valores e a rejeição original ao consumidor, com status 0. Evidência inicial: `/tmp/scriptc-promise-covariance-repro.log`.

A sondagem `coercibleValue` não reconhecia a conversão entre os tipos de Promise. Por isso `funcCoerceAdapter` emitia seu caminho de retorno incompatível: chamava o callback, descartava o resultado e lançava uma exceção. O runtime Rust já possuía `promise_view_map`, que preserva a identidade e registra observadores na Promise original; faltava ao frontend produzir essa operação.

## Implementação

- Uma capacidade explícita `nativePromiseViews`, habilitada para Rust, acompanha as passagens de lowering de build e análise.
- A operação interna `promise.view` aplica ao payload uma conversão admitida pelo compilador. A função de conversão é compartilhada por par de tipos, não captura variáveis e não adota nem resolve novamente a Promise.
- O backend usa a view existente no runtime. Atribuições diretas e resultados de callbacks utilizam a mesma conversão; tipos já iguais continuam passando diretamente.
- A validação da IR verifica origem, resultado e assinatura da conversão, inclusive após serialização. Conversores com capturas ou tipos incompatíveis são recusados. C/LLVM recusam explicitamente essa operação com `SC3001`; seus caminhos anteriores de lowering permanecem.
- A sondagem de conversões foi extraída de `lowerer.ts` para `value-coercion.ts`; o teto congelado caiu de 9328 para 9290 linhas. Nenhum teto foi aumentado. O runtime não precisou de alterações.

## Evidência comportamental

`tests/fixtures/promise-covariance/main.ts`, executado pelo harness nativo e pelo programa de corpus 3252, cobre valores numéricos e strings, callbacks que rejeitam, identidade da Promise através de `unknown`, ordem entre reações e microtasks, Promise pendente, identidade do motivo da rejeição, payloads record/array, mutação por uma view estrutural mais estreita, união numérica/string, `Promise<void>` e união com `void`. Os resultados são comparados byte a byte com Node, incluindo stderr e status, com auditoria de heap habilitada.

O teste de Proxy anterior agora executa tanto `() => unknown` quanto o contrato original `() => Promise<unknown>`. Todos os sete caminhos preservam a recusa explícita de assimilação de thenables Proxy, sem as rejeições extras do adaptador. Esse teste verifica uma limitação declarada; não afirma que a assimilação de Proxy foi implementada nem que sua saída seja igual à do Node.

Durante a ampliação da fixture, comparações diretas entre representações tipadas diferentes e uma atribuição a `(await promise).value` encontraram recusas independentes do compilador. A fixture compara identidade por um helper de argumentos `unknown` e faz o await antes da atribuição. Essas recusas não foram corrigidas neste ciclo. Uma tentativa de atribuir `Promise<number>` a `Promise<void>` foi corretamente rejeitada pelo TypeScript e removida da fixture; não é um programa válido a admitir.

## Validação e limites

- Regressão original corrigida e reexecutada contra Node; o corpus 3252 final passou (`/tmp/scriptc-promise-corpus-final.log`).
- A seleção ampliada aprovou outros 15 programas existentes de async, Promise, Effect, regex e escalares (`/tmp/scriptc-promise-regressions.log`). O programa novo foi reexecutado separadamente após estabilizar o último caso de união com `void`. A execução ampliada não foi um gate integral verde: uma edição da fixture durante a compilação comparou versões diferentes, e o worker já carregado ainda continha a versão anterior da conversão de `void`. Os runs finais partiram dos arquivos estabilizados.
- Faixa sanitized final: 5 testes aprovados, cobrindo a nova fixture, os dois contratos de Proxy e os dois testes de IR (`/tmp/scriptc-promise-focused-final.log`). As duas fixtures de regex também passaram na seleção anterior. Isso não representa instrumentação ASan do runtime Rust.
- Build do compiler aprovada; lint com zero erros e os 3140 avisos preexistentes. Manifest e tabela de reconhecimento de libcalls regenerados; a verificação de compatibilidade Node passou, sem mudanças nos artefatos da matriz. Limites de linhas e diff sem erros.
- Gates completos locais plain e sanitized, ambos com `--bail=1`, pararam na falha preexistente de `native-toolchain.test.ts:330` por ausência de `ccache.log`: 6 testes aprovados e 1 falha em cada faixa. Logs: `/tmp/scriptc-promise-full-plain.log` e `/tmp/scriptc-promise-full-sanitized.log`. Foi usado o fallback local devido à sessão Sandbox expirada registrada anteriormente. O checkpoint não está aprovado para publicação.

O suporte cobre as conversões de payload admitidas pelo compilador, não todas as formas de Promise, thenables ou TypeScript. Este ciclo não mede tempo de execução, CPU, RAM ou tamanho de binário comparável ao Bun.

## Nova tentativa do Redcode completo

O entrypoint original `packages/redcode/src/index.ts` foi compilado novamente com Rust, sem engine, target Bun, otimização release e a mesma seleção explícita de 34 pacotes da tentativa anterior. O `systemd-oomd` encerrou a primeira tentativa durante a compilação, com limite de pressão de 5 GiB e teto de 6 GiB; repetimos com os limites anteriores de 7/8 GiB, e o processo foi novamente encerrado. Os journals registraram picos de 5,2 e 7,3 GiB nessas duas tentativas. Isso é consumo do compilador, não de um executável Redcode.

Uma execução independente do checkpoint anterior `29101fb7`, com os mesmos argumentos e limites de 7/8 GiB, reproduziu o encerramento por `systemd-oomd`. Assim, a interrupção da build já ocorre sem esta correção de Promise nas condições atuais. O campo de pico de memória do journal dessa execução baseline foi inconsistente com a observação dos processos e não serve para comparar picos. Não houve novo resultado completo de diagnósticos nem executável em nenhuma dessas tentativas. A primeira invocação do baseline pelo pnpm falhou antes de iniciar o worker por causa dos links de dependências do worktree; a execução comparada usa diretamente o mesmo wrapper de recursos do repositório.

Os fontes do compilador permaneceram idênticos ao snapshot durante as tentativas, e todos os arquivos rastreados do Redcode foram verificados sem alterações. O [registro das tentativas](promise-covariance-redcode.json) preserva opções, proveniência, estados terminais e journals. O worktree baseline contém apenas links não rastreados para as dependências instaladas, sem alterações nos arquivos rastreados.

O próximo passo para retomar a build integral é reproduzir e perfilar o consumo de memória da análise TypeScript do grafo real. A correção de Promise está validada nos casos descritos; resolver a pressão de memória e os gates completos continua pendente.

Continuação da investigação de memória: [cache de diagnósticos por snapshot e vida útil da visão temporária de tipos](./semantic-diagnostics-cache.md). Esse checkpoint trata o custo da análise; não é evidência de build integral do Redcode nem de desempenho do seu binário.
