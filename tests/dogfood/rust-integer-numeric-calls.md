# Chamadas numéricas com intervalos inteiros

Uma região de bytes pode agora preservar valores inteiros vindos de uma
condicional e especializar chamadas diretas a helpers numéricos pequenos.
A prova segue a IR e os intervalos dos argumentos; não depende de nomes de
funções, módulos ou aplicações. O consumidor permanece inalterado.

`integer-ranges.ts` centraliza a prova de inteiros JS exatos para literais,
adição, subtração, multiplicação e união de intervalos. Zero negativo,
resultados fora do intervalo seguro, frações e operações não modeladas
permanecem no caminho f64.

`integer-calls.ts` admite parâmetros numéricos, locais imutáveis, aritmética
exata, `Math.abs`, comparações booleanas, condicionais e retornos. Exige
retorno provado em todos os caminhos. Rejeita efeitos, globais, capturas,
escritas, chamadas aninhadas, loops, suspensão e inicializadores de módulo.
Limites: oito argumentos, 32 locais, 32 statements por bloco, profundidade
16 e orçamento de 128 nós por helper; a região mantém seu orçamento global.

A especialização emite uma closure Rust de pilha invocada imediatamente.
Os argumentos são avaliados uma vez, em ordem, fora do escopo dos parâmetros.
Os retornos saem dessa closure, nunca da função chamadora. Não há alocação
de closure JS, memoização, mudança da ABI pública ou remoção de bounds checks.
Leituras condicionais continuam nos respectivos ramos, no ponto original.

## Evidência e validação

- Experimento diagnóstico em cópia do Rust gerado: mediana 576,98 → 513,16 ms
  em sete amostras por candidato; PNGs equivalentes. Esse experimento não é
  a implementação nem substitui o benchmark integrado.
- 24 testes focados passaram, incluindo provas negativas, orçamento, emissão
  estrutural, preservação da IR e fallback.
- Os 16 programas diferenciais Rust 3123–3138 passaram contra Node.
- Corpus 3138 cobre 216 combinações de bytes, empates, extremos, views diretas
  e indiretas, limites fracionários, zero negativo, aritmética fora do intervalo
  seguro, efeitos e ordem dos argumentos.
- Build final do Redwall: 38 contratos, com 26 PNGs iguais ao Bun, engine none,
  sem FFI externa e zero fences. Os 116 hashes de fontes do consumidor são
  idênticos aos do controle. Binário de 4.069.136 bytes, 320 bytes menor.
- Corpus 3138 passou também em C e LLVM com sanitizers.
- Build do workspace, ESLint sem warnings, whitespace e tetos de linhas
  passaram. `emitter.ts` continua com 1.200 linhas; apenas recebe o mapa de
  funções na construção da análise de inteiros.

O primeiro corpus expôs um defeito separado em `bytes_set_from`: a cópia em
bloco para Buffer apoiado em Uint32Array acessa storage direto vazio e
entra em panic. A reprodução mínima está em `backed-set-repro.ts` no diretório
de evidência. A fixture de especialização inicializa a mesma view com escritas
individuais; a correção do bulk set continua pendente e não é mascarada como
paridade completa.

## Benchmark integrado

Cada comparação usa somente dois candidatos, alterna sua posição, fixa a
afinidade no mesmo CPU e executa processos novos. Um aquecimento e 11 amostras
medidas por binário; todas as 24 saídas de cada rodada são equivalentes.
Builds e testes nossos terminaram antes das medições. O host é compartilhado;
os tempos absolutos de rodadas diferentes não são comparáveis.

| Comparação | Controle | Candidata | Resultado |
| --- | ---: | ---: | --- |
| Rust anterior × chamadas inteiras (`measurements-rust`) | 954,35 ms | 864,29 ms | 9,4% menos tempo; 11/11 pares |
| Bun compilado × chamadas inteiras (`measurements-bun`) | 889,33 ms | 813,52 ms | 8,5% menos tempo; 10/11 pares |
| Rust anterior × chamadas inteiras (`measurements-rust-confirm`) | 918,91 ms | 790,01 ms | 14,0% menos tempo; 11/11 pares |
| Bun compilado × chamadas inteiras (`measurements-bun-confirm`) | 1.018,20 ms | 923,95 ms | 9,3% menos tempo; 9/11 pares |

Na rodada contra Bun: CPU mediana 0,86 → 0,79 s, RSS máximo mediano
142.624 → 111.192 KiB e binário 81.413.600 → 4.069.136 bytes. A medição cobre
o renderer original através do adapter TS de contratos, com o mesmo JSON,
arte PNG e fonte TTF; não é uma medição de todas as operações da CLI.

Na confirmação contra Bun, CPU mediana 0,99 → 0,90 s e RSS máximo mediano
141.632 → 111.172 KiB. A candidata venceu 22/22 pares contra o Rust anterior
e 19/22 contra Bun nas duas rodadas de cada comparação. Mantemos a mudança:
há ganho reproduzido nesse workload e paridade de saída. Isso não prova
superioridade para toda aplicação TypeScript nem para toda operação do Redwall.

O gate completo plain/sanitized continua não aprovado; a correção do bulk set
de views e a falha já registrada de rejeição de import dinâmico seguem abertas.
Evidências: `/tmp/scriptc-numeric-calls-20260909/`.
