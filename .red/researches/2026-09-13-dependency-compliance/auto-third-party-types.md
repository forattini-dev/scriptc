# AUTO com declarações de terceiros

Este ciclo amplia a aquisição implementada em `757640b6`: `npmStatic: "auto"` e a admissão automática de bibliotecas podem tentar compilar dependências JS com declarações de `@types`, instaladas ou adquiridas. A implementação permanece na branch `fix/redcode-runtime-package-identity-20260913`, no worktree separado; os repositórios consumidores não foram modificados.

## Contrato implementado

- O runtime precisa resolver do importador original, para o mesmo specifier/subpath das declarações. A atribuição continua pertencendo ao pacote executável, inclusive para nomes com escopo.
- O nome do manifest de `@types` deve corresponder ao runtime. As duas versões precisam ser estáveis e da mesma major, ou da mesma minor quando a major é zero. Esse filtro permite uma tentativa; não prova compatibilidade de API.
- A decisão considera os pares de runtime/declaração encontrados em cada lote de descoberta, em vez de usar somente a primeira importação do pacote. Pares repetidos são verificados uma vez para evitar releitura desnecessária. A unidade de admissão e fallback continua sendo o nome do pacote.
- Os corpos executáveis continuam inferidos. Assinaturas de funções, constantes e classes presentes apenas nas declarações não viram implementações nem substituem os tipos dos corpos JS.
- Para corpos ESM, a ponte existente de tipos apagados aceita interfaces e aliases estruturais autocontidos das declarações resolvidas. Os vínculos são específicos dos arquivos executáveis, incluindo realpaths, e ficam no contexto de uma operação, preservados durante seus reloads de fallback. Declarações adquiridas continuam fora de `externalTypes`.
- Dois subpaths com declarações diferentes para o mesmo arquivo executável tornam a ponte ambígua; o compilador não escolhe arbitrariamente um deles. Tipos genéricos, declarações dependentes e superfícies que a ponte já recusava continuam sujeitos ao fallback.
- O fallback por incompatibilidade da superfície inferida permanece ativo. A admissão AUTO não garante que o lowering ou a build sem engine sejam possíveis.

## Evidência nativa

O teste de aquisição agora usa AUTO, sem uma lista explícita de pacotes. Seu `@types` adquirido declara incorretamente `answer(): string`, mas o JS retorna `42`; o consumidor usa uma interface `Row` das declarações e um campo numérico. O Rust executa o corpo correto, com saída `42\n`, stderr e status iguais aos do Node, sem engine. Uma segunda análise com lock frozen e modo offline preserva a admissão e não apresenta diagnósticos.

O corpus npm ganhou `tests/fixtures/npm-static/third-party-types`, dirigido por `tests/harness/npm-static-third-party-types.test.ts`. Ele usa `@types` instalado, assinatura de valor propositalmente incorreta e interface estrutural. O binário Rust é comparado ao Node byte a byte, com auditoria de heap Rust habilitada.

## Dependência real: o bloqueio mudou

Um projeto descartável importou o `is-extglob@2.1.1` original instalado no RedSkills, sem editar sua implementação. A aquisição resolveu `@types/is-extglob@2.1.0` do npm com integridade SHA-512; a build reutilizou o lock em modo offline/frozen. O AUTO agora registra `is-extglob` como `static`.

A build Rust com `allowEngine: false` ainda foi recusada por `SC3003`, contendo `SC1121`: o corpo usa `/.../g.exec(str)`, e a implementação atual recusa regexes com estado `lastIndex` nesse caminho. O texto do diagnóstico menciona `.test()`, embora o trecho real use `.exec()`. Não houve executável para esse pacote real e não medimos ganho de performance. Log: `/tmp/scriptc-auto-real-types.log`; projeto: `/tmp/scriptc-auto-real-types-uqItUa`.

## Próximos passos

Atualização posterior: o item 1 foi implementado e a dependência real passou em 17 casos diferenciais Node/Rust. Ver [regex com estado no Rust](regex-stateful-rust.md); o bloqueio registrado acima descreve o estado deste checkpoint anterior.

1. Implementar e testar o comportamento de regex global/sticky e `lastIndex`, incluindo chamadas repetidas, ausência de match, índices Unicode e `.exec()`/`.test()`, antes de liberar a dependência real sem engine. Corrigir também a identificação do método no diagnóstico.
2. Ampliar a preservação de tipos dependentes e genéricos com proveniência explícita, sem substituir assinaturas executáveis por declarações.
3. Retomar o adaptador de covariância de Promise e os bloqueios nativos identificados no Redcode. Este ciclo não refez a contagem completa de diagnósticos nem produziu o CLI completo do Redcode.
4. Resolver os bloqueios dos gates completos antes de publicar. A existência de `@types` e a admissão AUTO, isoladamente, não provam compilabilidade integral de uma dependência.

## Validação e limites do checkpoint

- A seleção focada passou com 44 testes plain e 45 na faixa sanitized, incluindo o corpus Rust adicional. Depois dos últimos ajustes de proveniência, deduplicação de pares e três casos negativos adicionais, passaram 30 testes plain e 29 sanitized das superfícies afetadas. Esses totais se sobrepõem e não devem ser somados.
- A seleção final do harness de admissão AUTO e recusa de JS sem declarações passou: 7 testes, 94 não selecionados (`/tmp/scriptc-auto-types-admission-harness.log`).
- Outros 25 testes de aquisição, identidade, ciclo de vida, subpaths e kernels passaram, incluindo diferenciais Rust para reexports e Effect. Logs: `/tmp/scriptc-auto-types-regression.log`, `/tmp/scriptc-auto-types-final-plain.log`, `/tmp/scriptc-auto-types-sanitized.log`, `/tmp/scriptc-auto-types-last-plain.log`, `/tmp/scriptc-auto-types-last-sanitized.log`.
- Build do compiler passou. Lint completo passou com zero erros e os 3140 avisos já existentes; o helper novo não introduziu avisos. Os limites de linhas e `git diff --check` passaram. O teto congelado de `index.ts` caiu de 2418 para 2417 linhas.
- Os gates locais completos foram executados em plain e sanitized com `--bail=1`; ambos pararam na ausência de `ccache.log` em `native-toolchain.test.ts:330`, como no ciclo anterior. Logs: `/tmp/scriptc-auto-types-full-plain.log` e `/tmp/scriptc-auto-types-full-sanitized.log`. A sessão Sandbox já estava expirada no preflight registrado no ciclo anterior; não houve novo login.
- A verificação ampliada de bibliotecas encontrou falhas na família `scr_jsval_*` para a biblioteca npm de K12, em C e LLVM. Os dois casos foram reproduzidos no checkpoint anterior `514905e8` com diretório `.cache` separado: `/tmp/scriptc-auto-types-baseline-library-isolated.log`. Não se trata de uma correção entregue neste ciclo e os gates completos continuam vermelhos. A varredura ampliada de bibliotecas foi interrompida após essa reprodução; sua saída parcial em `/tmp/scriptc-auto-types-harness.log` não representa um gate concluído.
- O worktree original e os repositórios Redcode, RedSkills e RedDev foram verificados limpos. Não houve push, merge ou release.
