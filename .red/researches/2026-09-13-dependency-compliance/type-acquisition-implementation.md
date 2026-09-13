# Implementação da aquisição de tipagens — 2026-09-13

Este ciclo melhora a descoberta e o uso de declarações. Não equivale à compilação integral do Redcode, nem ao cumprimento da meta de runtime exclusivamente Rust em todas as dependências.

## Entregas

- Declarações de `files`, `include`, `extends`, referências de projeto, `types` e `typeRoots` entram no checker; fontes executáveis não importados continuam fora.
- Fontes de workspace alcançados contribuem suas próprias configurações. Registros locais configurados podem ter representação nativa. Declarações adjacentes a JS preservam a inferência do corpo.
- A CLI usa `--types-mode=auto` por padrão. `local` usa somente o projeto instalado; `offline` exige pins e bytes em cache para cada aquisição necessária. A API síncrona `analyze` permanece local. `analyzeAsync` oferece aquisição; `compile` recebe `typeAcquisition` explicitamente.
- `--types-lock`, `--types-cache` e `--frozen-types-lock` configuram persistência. O padrão do lock é `scriptc.types.lock.json` junto ao package/tsconfig mais próximo do entrypoint.
- O lock fixa identidade da instalação, versão e hash do manifesto runtime, import exato, condições, versão das declarações, URL e integridade SHA-512/SHA-256, e o grafo de dependências das declarações.
- Downloads usam HTTPS do registry npm, limites de tamanho/tempo e nenhuma execução de scripts. A extração em memória mantém apenas declarações e JSON. Links, caminhos inseguros e entradas especiais não suportadas são recusados. O cache é reverificado em cada uso.
- O TS7 resolve o subcaminho exato, incluindo `exports`, `types` e `typesVersions`. Montagens virtuais ficam no contexto de uma compilação e respeitam a instalação do importador, inclusive duas versões simultâneas.
- Declarações adquiridas não entram em `externalTypes`. As assinaturas não substituem corpos executáveis. O cache de executáveis distingue modos de aquisição e não reutiliza um frontend com declarações virtuais sem revalidá-lo.
- Falhas da aquisição aparecem como `SC4030`, com causa explícita. Um lock incompatível, cache corrompido ou subcaminho ausente não é aceito silenciosamente.

## Evidência

- Importador original do RedSkills `apps/dev/src/core/toon-version.ts`: seu `js-yaml.d.ts` já existente agora entra no programa; preflight vazio, consumidor sem alterações.
- Testes cobrem tipagem efetiva, tipos errados, isolamento entre cargas, duas versões instaladas, `typesVersions`, dependências transitivas, incompatibilidade de versão, ausência de subcaminho, integridade, traversal, offline e frozen. Imports ausentes nas declarações são recusados mesmo quando o consumidor usa `skipLibCheck`.
- Verificações focadas: 46 testes plain passaram antes do caso adicional de grafo incompleto; 47 passaram na faixa sanitized. A seleção final dos 22 contratos de aquisição, declarações locais, API nativa e CLI passou em plain após os últimos ajustes. Build compiler/CLI passou; lint completo teve zero erros e avisos preexistentes, e o lint final dos módulos novos passou sem avisos. Os limites de linhas continuam respeitados; `index.ts` foi reduzido por extração do contrato de API.
- Teste nativo usa uma declaração de biblioteca propositalmente incorreta. Com a implementação selecionada estaticamente, Rust executa o corpo inferido e produz exatamente `42\n`, como Node, sem engine.
- Experimento real: `is-extglob@2.1.1` instalado no RedSkills, ligado a um projeto temporário, adquiriu `@types/is-extglob@2.1.0` do npm. SHA-512 verificado, zero diagnósticos de preflight e replay offline/frozen com os mesmos dois arquivos. Evidência local: `/tmp/scriptc-real-types-result.json`.
- Gate remoto não iniciou: a sessão Vercel CLI expirou no preflight. O fallback local foi executado em plain e sanitized, com `--bail=1`; ambos pararam em `native-toolchain.test.ts`, teste `public native builds re-probe ccache availability after PATH changes`, por ausência de `ccache.log`. Não houve aprovação do gate completo.
- A mesma falha foi reproduzida em checkout separado do checkpoint anterior `514905e8`, antes da aquisição. Também foi reproduzida ali a falha de replay do executável no bootstrap legado (`executableRestored` falso nas chamadas seguintes). Isso localiza esses dois bloqueios fora desta mudança; não dispensa corrigi-los antes de publicar.
- Logs: `/tmp/scriptc-types-local-plain.log`, `/tmp/scriptc-types-local-sanitized.log`, `/tmp/scriptc-types-baseline-ccache-direct.log`, `/tmp/scriptc-route-repro-baseline.log`. Não houve push nem release.

## Limites e próxima etapa

A descoberta de downloads neste ciclo parte de imports alcançados com TS7016. Um projeto com JSDoc suficiente ou shim local não precisa de download. Outros casos, como um import com `any` sem esse diagnóstico, tipos de valor perdidos após inferência ou diretivas de tipos ausentes, ainda precisam de análise própria.

A seleção automática usa versões estáveis de mesma major (mesma minor em runtime 0.x). Isso é um filtro conservador, não uma prova de compatibilidade de API. Divergências conhecidas como `@npmcli/config` runtime 10 e `@types` 6 precisam de auditoria de contrato ou inferência melhor; não escolhemos latest indiscriminadamente. Ciclos de dependências de pacotes de declaração são recusados neste ciclo.

A próxima implementação é preservar informação útil das declarações ao verificar os corpos e ampliar a admissão AUTO de JS com `@types`. A aquisição sozinha não resolve essa admissão. Depois vêm os bloqueios de inferência/Promise, famílias de APIs nativas e substituição das integrações estrangeiras. `ring` e SQLite existentes ainda impedem afirmar pureza Rust de todo o runtime.
