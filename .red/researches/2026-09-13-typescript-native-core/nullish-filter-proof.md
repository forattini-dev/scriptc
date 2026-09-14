# Filtros comprovados e avaliação de comparações nullish

## Reprodução

Depois do checkpoint 9028f836, o Redcode alcançou dois filtros em packages/llm/src/schema/options.ts cujo callback escrito tem a forma (item): item is Record<string, unknown> => item !== undefined. O frontend recusava a anotação mesmo que o corpo executasse o teste necessário. O mesmo ocorreu na redução com strings, afastando a hipótese de que o problema fosse a representação do dicionário.

O corpus 3255 falhou com SC1090 no Rust antes da correção. Já existia prova de predicates escritos contra null, mas ela não reconhecia undefined nem parênteses nos operandos. Ao ampliar o caso, x != undefined esbarrou numa recusa independente da comparação. Logs de reprodução: /tmp/scriptc-filter-proof-red.log e /tmp/scriptc-filter-proof-first.log.

## Contrato implementado

nullish-filter-proof.ts centraliza a identificação de constantes e a prova do corpo do filtro. Reconhece null literal e undefined intrínseco/stdlib, conferindo o símbolo para não tratar uma variável local como constante. Admite comparação direta ou invertida, parênteses e corpo com um único return. Somente o parâmetro real do callback pode ser comparado. A união de origem deve conter apenas o tipo retido e os valores excluídos pela comparação.

A comparação estrita exclui somente o valor testado. A comparação não estrita contra null ou undefined exclui ambos. Predicates que retêm outros tipos, removem null usando somente !== undefined, usam outra variável ou modificam o parâmetro continuam recusados. A anotação de tipos sozinha não autoriza extrair um valor da união. Predicates nomeados, corpos arbitrários e refinamento para várias alternativas da união continuam fora deste passo.

A comparação ordinária compartilha a mesma prova de constante: x == undefined e x != undefined usam o teste nullish existente, sem assumir que todo identificador escrito undefined tem esse valor. Não foram adicionadas APIs Node/Bun nem alterado o consumidor.

## Efeitos que uma simplificação não pode eliminar

O corpus 3256 reproduziu outro erro: o frontend sabia que uma expressão tipada como string nunca seria null e substituía a comparação por false, descartando a expressão inteira. O resultado nativo mostrava zero chamadas onde Node executava uma, perdia uma exceção e removia o incremento do índice. A reprodução inclui a forma == null que já existia antes da ampliação para undefined. Log: /tmp/scriptc-filter-effects-red.log.

O resultado booleano ainda pode ser constante, mas expressões cuja avaliação é observável agora permanecem numa sequência antes dele. A correção cobre os ramos de valor unitário, união sem valores nullish e valor não anulável. Não acrescenta um teste de tipo em runtime quando a resposta já é conhecida. Chamadas, exceções, indexação e acesso a getters permanecem observáveis. O caminho de união com dois valores nullish e operando não reemitível conserva a recusa existente; esse contrato ainda precisa de avaliação única própria.

## Testes e limites

O harness novo exige Rust sem engine e sem runtime fences, compara stdout, stderr e status com Node e ativa a auditoria de heap. O corpus 3255 cobre os dois formatos de dicionário do Redcode, identidade e mutação compartilhada, zero/undefined, strings vazias, comparações estritas/não estritas, operandos invertidos, parênteses e o filtro inferido já suportado. Há seis testes negativos de predicates não comprovados. O corpus 3256 protege efeitos e exceções das simplificações.

A seleção inicial ampliada passou com 16 testes, incluindo corpus anteriores de filtros e comparações. Os gates gerais continuam necessários e nenhum resultado desta etapa equivale a um binário Redcode ou ao suporte integral de JS/TS.

Validação concluída até aqui:

- Seleção focada: 16/16, incluindo os oito corpus Rust selecionados e oito contratos do harness. Log: /tmp/scriptc-filter-proof-focused.log.
- Configuração sanitized focada: 10/10, incluindo os dois corpus C instrumentados e os oito contratos de recusa/Rust do harness. Essa variável não instrumenta o runtime Rust com ASan; os binários Rust usam auditoria de heap. A versão final do corpus 3256 inclui retorno de união e getter. Log: /tmp/scriptc-filter-proof-sanitized-focused.log.
- Diagnósticos completos: 121/121, sem atualizar snapshots. Log: /tmp/scriptc-filter-proof-diagnostics.log.
- Build TypeScript aprovado. Lint: zero erros; 279 avisos em arquivos existentes, nenhum nos novos arquivos. Limites de tamanho e git diff --check aprovados. Logs: /tmp/scriptc-filter-proof-build.log e /tmp/scriptc-filter-proof-lint.log.

## Redcode e gates gerais

O Redcode original terminou a análise por recusa controlada em 465,93 s, com pico de 4,920 GiB, sem timeout, OOM, SC0001 ou SC9001. O perfil mantém uma CPU, GOMEMLIMIT=4GiB, memória alta de 7G, máximo de 8G e nenhum swap. Os 1.335 textos-fonte conservaram ordem e hashes. As fontes do compilador, os arquivos rastreados do consumidor e os arquivos físicos do grafo anterior permaneceram inalterados durante a medição.

Os diagnósticos passaram de 3.078 para 3.072: foram removidas sete recusas de filtros em schema/options.ts, git.ts, config.ts, instruction-context.ts e project/copy-strategies.ts; apareceu uma ocorrência SC2004 herdada de outro bloqueio de untracked em git.ts. Não são sete programas compilados nem sete bugs independentes. Ainda não há binário Redcode.

Esta execução foi mais demorada que a anterior de 273,77 s. Houve build TypeScript e validações concorrentes, com variação também nos tempos das suítes; não houve comparação alternada em condições equivalentes que isolasse a causa. O resultado atende ao limite experimental de 600 s/6 GiB nesta rodada, mas não comprova ganho de velocidade. Uma conclusão de desempenho exige medições comparáveis adicionais. Metadados em nullish-filter-proof.json; captura em /tmp/scriptc-redcode-filter-proof-20260914a, comparador /tmp/scriptc-redcode-typed-rest-20260914a.

Os gates locais completos plain e sanitized foram executados com bail=1. Ambos pararam com oito testes aprovados e a falha C de library-contract: símbolos scr_jsval_* ausentes, mesma falha registrada no checkpoint anterior. Os gates gerais continuam vermelhos; este é um checkpoint de implementação, não uma aprovação de release. Logs: /tmp/scriptc-filter-proof-full-plain.log, /tmp/scriptc-filter-proof-full-sanitized.log e /tmp/scriptc-filter-proof-gates.json. O fallback local continua sendo usado porque as credenciais Sandbox não estão disponíveis.

O próximo contrato principal continua sendo optional chaining sobre subuniões de records/classes. A prova de predicates por valor e a avaliação única de comparações sobre uniões com ambos os valores nullish permanecem trabalhos separados, sem ampliar bibliotecas externas neste passo.

A versão final do corpus 3256 foi reconferida isoladamente após a inclusão dos casos de união e getter: 2/2, em C com sanitizadores e Rust sem engine, ambos com paridade Node. Log: /tmp/scriptc-filter-proof-effects-final.log.
