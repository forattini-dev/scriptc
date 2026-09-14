# Chaves computadas na representação nativa com chaves string

## Defeito reproduzido

O corpus 1703-arguments-rest-props.cjs era a única falha da seleção ampliada de 113 testes Rust no checkpoint 8a81bb31. A função build(field, n) contém { [field]: n, actual: 0, [field + '2']: n * 2 }. O frontend recusava a chave de tipo interno jsval como SC1090, e as atualizações de rec.actual e o retorno de rec acumulavam erros em cascata. Com allowEngine=false, o teste novo reproduziu a recusa antes de chegar à emissão.

A hipótese principal foi uma lacuna na admissão do frontend: jsval já tinha uma conversão de string implementada, mas as duas rotas de chaves computadas aceitavam apenas string/f64/bool/dyn. As hipóteses seguintes eram perda de ordem de avaliação durante a conversão e um bloqueio independente nas atribuições ao objeto. O diferencial de ordem já passava para entradas admitidas; após corrigir a admissão, o corpus original inteiro passou, incluindo as atribuições.

## Implementação

lowerComputedStringKey centraliza a conversão usada por literais de objeto dinâmico e por registros com assinatura de índice. Reutiliza lowerer.ensureString, que já representa jsval como jsOp.toStr; Rust executa essa operação com seus valores nativos quando o programa dispensa engine. Não se adicionou uma engine, uma implementação de biblioteca ou uma exceção específica para o fixture.

O arquivo lower-exprs.ts caiu de 10.911 para 10.891 linhas, com redução do teto congelado correspondente. Essa redução é por arquivo, não uma alegação de redução do tamanho total do compiler. O helper novo tem 20 linhas.

O contrato permanece restrito ao lado string de ToPropertyKey. Não há suporte novo a armazenamento dinâmico por símbolo: o teste negativo fixa a recusa de uma chave symbol em uma representação com assinatura de índice string. Isso não é uma prova de suporte a todas as chaves possíveis em valores any, nem de implementação completa de Symbol.toPrimitive ou de armazenamento dinâmico por símbolo.

## Validação focada

- O corpus original falhou antes da mudança e passou depois, com Rust, allowEngine=false, execution.engine=none e nenhuma runtime fence.
- O grupo completo de protótipos dinâmicos de emit-rust.test.ts passou, incluindo os fixtures posteriores a 1703 que a falha anterior impedia de executar.
- O diferencial de conversão cobre string, número, boolean, null, undefined, métodos toString com efeitos, uma exceção que impede a avaliação do valor, chaves duplicadas e ordem de inserção.
- O diferencial TypeScript com assinatura de índice cobre chave any, spread, substituição de chave existente e chave numérica.
- O teste negativo de chave simbólica exige a recusa do próprio armazenamento, sem depender de um bloqueio em console.log ou do tipo de retorno object.
- Os quatro testes focados passaram em plain e com SCRIPTC_SAN=1. Essa configuração não instrumenta o runtime Rust com ASan. Os diferenciais positivos exigem sucesso de Node e Rust, stdout/stderr iguais e auditoria de heap Rust habilitada.
- O build TypeScript passou. ESLint do arquivo legado e dos arquivos novos: zero erros, 95 avisos existentes no legado; os arquivos novos também foram verificados separadamente. Limites de fontes e git diff --check passaram.

Logs: /tmp/scriptc-computed-keys-{red,direct-red,green,expanded,final-focused,sanitized-focused,lint,new-files-lint,build}.log. O teste negativo inicial recusava o tipo object antes de chegar à chave; seu retorno foi alterado para uma assinatura de índice string para atingir a fronteira pretendida. Não se alteraram os consumidores.

## Espaço para validar

Foram removidos 835 executáveis ELF descartáveis de diretórios de testes Rust em /opt/cargo-target/scriptc-validation-20260913, após verificar ausência de processos de validação ativos. A lista fixou caminho, inode, tamanho e mtime antes da remoção. Fontes gerados, logs e diretórios das reproduções de erros/coerções/chaves foram preservados. O espaço disponível em /opt passou de aproximadamente 32 para 74 GiB. Registro: /tmp/scriptc-previous-validation-executables-cleanup.json. Não foram removidos fontes de projeto, toolchains ou artefatos consumidores.

A contraprova de assinatura de índice também foi executada no checkpoint congelado 63624e7a: já compilava. Portanto, esse caso protege o comportamento existente da segunda rota compartilhada; não é apresentado como um defeito adicional corrigido. Artefatos: /tmp/scriptc-indexed-keys-baseline.{json,log}.

## Redcode original

A tentativa /tmp/scriptc-redcode-computed-keys-20260914a retornou normalmente de compile() em 118.563 ms; o monitor terminou em 122,15 s, exit 1, sem timeout. O resultado foi refused, com 3.087 diagnósticos, nenhum SC0001 e nenhum binário. Pico do cgroup: 6.665.617.408 bytes (6,21 GiB); zero eventos high/max/oom/oom_kill na última amostra. Mantidos entrypoint original, os 34 pacotes explícitos, Rust release, target bun, allowEngine=false, uma CPU e teto de segurança de 8 GiB sem swap.

Os códigos e as localizações dos diagnósticos são os mesmos da tentativa anterior das raízes. Sete textos mudaram na apresentação dos tipos genéricos; o diff integral foi retido, sem tratar essa variação como redução de bloqueios. O retorno capturou 1.374 sourceTexts reais. Foram criados quatro programas. Fontes atuais do compiler, arquivos versionados do consumidor e arquivos do grafo anterior permaneceram iguais durante a execução. Os arquivos versionados do consumidor e os do grafo anterior também não mudaram entre as duas tentativas comparadas.

O novo preparador reconstrói os hashes de todas as 488 fontes TS atuais de packages/compiler/src, incluindo o helper novo, e atualiza compilerHead e consumerHead a partir de git. Não reutiliza a lista de fontes nem o campo compilerHead antigo. O registro de entrada fica em before.json; o compiler contém a mudança ainda não commitada, identificada pelos hashes. Não se afirma que essa captura seja um snapshot físico de todas as dependências instaladas.

A tentativa anterior terminou em 155,15 s e pico de 7,00 GiB. Como não são três repetições controladas, esses números não estabelecem ganho percentual causado pela correção. A meta de cada análise consumir no máximo 6 GiB permanece aberta. Esta mudança resolveu a regressão do corpus, mas não reduziu as ocorrências de bloqueios do Redcode neste experimento.

Artefatos: build.json, execution.json, hash-check.json, input-comparison.json, diagnostic-comparison.json, phases.jsonl e memory.jsonl no diretório da tentativa. O gate geral foi iniciado depois do término da medição; uma validação focada curta ocorreu durante a tentativa.

## Gates gerais deste checkpoint

Os gates locais foram executados com o Zig 0.13.0 diretamente no PATH, sem LD_LIBRARY_PATH herdado, uma worker e limite de duas CPUs/3 GiB. A sessão Sandbox já havia sido verificada como expirada. O plain terminou com 71 testes aprovados, dois skips e uma falha em 1.018,33 s; o sanitized terminou com oito aprovados e uma falha em 144,66 s. Ambos usaram --bail=1 e pararam em library-contract, emissão C, no teste de identidade dos módulos npm. Não completaram as demais suítes e não são gates verdes.

Os dois logs repetem os símbolos ausentes SCR_JSOP_ADD, scr_dyn_from_jsval, scr_jsval_binop, scr_jsval_from_dyn e scr_jsval_release. A mesma lista está na reprodução de e50752ff em /tmp/scriptc-core-contract-c-baseline.log, anterior a esta implementação. O plain aprovou antes a suíte completa de toolchain/cache (63 aprovados, dois skips). Os gates pararam antes da seleção Rust, executada separadamente abaixo. Logs: /tmp/scriptc-computed-keys-full-{plain,sanitized}.log; códigos terminais em /tmp/scriptc-computed-keys-full-gates.json.

## Orçamento experimental do checker nativo

Foi aplicado GOMEMLIMIT=4GiB somente ao ambiente dos processos do experimento, sem alterar a configuração padrão do compiler. A variável foi conferida no processo real do checker TypeScript 7.0.2. É um orçamento de heap Go, não um limite de memória total de Node + checker; o cgroup continuou com uma CPU, MemoryHigh=7G, MemoryMax=8G, sem swap e timeout de 600 s.

| Execução | Tempo de compile() | Pico do cgroup | sourceTexts | Diagnósticos finais |
| --- | ---: | ---: | ---: | ---: |
| a, sem orçamento Go | 118.56 s | 6.208 GiB | 1374 | 3087 |
| b, GOMEMLIMIT=4GiB | 178.83 s | 4.700 GiB | 1374 | 3087 |
| c, GOMEMLIMIT=4GiB | 195.24 s | 4.679 GiB | 1323 | 3087 |
| d, GOMEMLIMIT=4GiB | 198.51 s | 4.704 GiB | 1323 | 3087 |

As três tentativas experimentais retornaram refused, sem timeout, sem SC0001 e sem binário. Os códigos e localizações dos diagnósticos finais coincidem com a tentativa a. A verificação dos hashes das 488 fontes TS do compiler, 6.848 arquivos versionados do consumidor e 4.223 arquivos do grafo anterior não detectou alterações em nenhuma execução. Os eventos high/max/oom/oom_kill permaneceram zerados nas últimas amostras.

A comparação dos sourceTexts impede declarar as execuções equivalentes: b preservou os 1.374 arquivos de a; c e d capturaram 1.323, com ausência de 51 arquivos JS internos de undici e nenhum arquivo acrescentado ou conteúdo alterado entre os arquivos comuns. As três rodadas relevantes de criação de programas conservaram exatamente as mesmas raízes e ordem; só a sondagem inicial descartável usa um nome temporário diferente. A variação de 51 arquivos de undici já aparecia na investigação anterior sem orçamento Go. Portanto, não foi atribuída ao GOMEMLIMIT nem à correção de chaves. Ver [variação anterior do grafo](../2026-09-13-dependency-compliance/semantic-diagnostics-cache.md#variação-do-grafo-ainda-não-isolada).

Os números de tempo/RAM satisfazem os tetos experimentais nas três tentativas, mas a meta de escala permanece aberta enquanto a variação do grafo não for explicada e estabilizada. A primeira comparação com grafo igual também mostra maior tempo e CPU, não ganho geral: as últimas amostras de CPU acumulada do cgroup foram aproximadamente 120 s em a e 180 s em b. São amostras próximas do término, não contadores finais exatos. Nenhum desses números mede o desempenho de um executável Redcode.

As repetições foram sequenciais entre si, com validação local concorrente em outro cgroup limitado. Não houve três baselines alternados nem controle físico de todos os arquivos de dependências. Não se afirma ganho percentual causal nem se adota o orçamento como padrão. Diretórios: /tmp/scriptc-redcode-computed-keys-20260914a e /tmp/scriptc-redcode-computed-keys-gomem-20260914{b,c,d}. Cada repetição guarda build.json, execution.json, hash-check.json, diagnostic-comparison.json, source-capture.json, phases.jsonl e memory.jsonl; experiment.json identifica o baseline real, pois o campo legado baseline de build.json ainda aponta para uma sondagem antiga.

O próximo trabalho de escala é reduzir a variação do grafo a uma reprodução fiel, preservando resolução de tipos e corpos executáveis das dependências. A contagem de 3.087 diagnósticos não equivale a problemas independentes: há erros herdados de declarações bloqueadas. Limitações da convenção de chamada de funções rest também aparecem na captura e pertencem ao núcleo do compilador, não a uma exigência de reescrever consumidores.

## Resultado da seleção Rust ampliada

A seleção de emit-rust.test.ts, emit-rust-dynamic-error-subclass.test.ts, emit-rust-dynamic-array-tostring.test.ts e emit-rust-computed-object-keys.test.ts terminou com 117 testes aprovados em quatro arquivos, zero falhas e exit 0, em 401,34 s. O arquivo principal aprovou seus 108 testes, inclusive todo o grupo de protótipos dinâmicos que antes parava no corpus 1703. Os outros arquivos aprovaram quatro testes de erros, um de conversão de arrays e quatro de chaves computadas. Essa seleção é ampliada, não a totalidade dos testes Rust do repositório. Log: /tmp/scriptc-computed-keys-rust-suite.log.

Os quatro testes novos também passaram isoladamente na configuração sanitized, mas a seleção ampliada de 117 foi executada somente em plain. SCRIPTC_SAN não é instrumentação ASan do Rust. Os gates gerais permanecem vermelhos pelo contrato C documentado acima; este checkpoint não é autorização de publicação nem conclusão do contrato de linguagem.
