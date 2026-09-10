# Redwall: comparação C/LLVM e remoção da cópia de compressão Rust

Medição de 2026-09-09 no worktree `rust-effect-native`, HEAD
`143bd19c658985f257738b0338d8476767bb9b6a` com WIP. O consumidor não foi alterado.

## Resultado

A compressão Rust copiava 33.179.760 bytes antes de comprimir o PNG 4K.
C/LLVM passam o ponteiro original ao zlib. O runtime Rust agora empresta o slice
seguro nas operações síncronas deflate/default/nível/raw e gzip. Views com backing
indireto conservam a materialização anterior; o objeto GC do resultado é criado
somente depois do fim do empréstimo. Nenhum `unsafe` foi adicionado.

Medianas: 11 processos novos por candidato, uma execução de aquecimento por
candidato, ordem alternada, afinidade CPU 2, quota de um núcleo. GNU time mede
CPU usuário+sistema e pico RSS. Tempo inclui lançamento do processo. Nenhum
build/teste nosso rodou junto, mas a máquina é compartilhada e houve dispersão
considerável: consulte mínimos/máximos na evidência. É uma comparação do render
4K fornecido, não uma afirmação universal de superioridade entre linguagens.

| Backend | Tempo (ms) | CPU (s) | Pico RSS (MiB) | Binário (bytes) |
| --- | ---: | ---: | ---: | ---: |
| Rust anterior | 624.16 | 0.61 | 108.62 | 4,069,616 |
| Rust com entrada emprestada | 591.40 | 0.57 | 76.81 | 4,070,096 |
| Bun compilado | 667.24 | 0.65 | 135.56 | 81,413,600 |
| C | 2384.62 | 2.37 | 82.15 | 861,088 |
| LLVM direto | 2410.15 | 2.39 | 82.15 | 850,752 |

Contra a versão Rust anterior, a mudança reduziu o RSS mediano em
29.29% e o tempo em
5.25%; venceu 9/11 pares de tempo.
Contra Bun, foram 43.34% menos RSS,
12.31% menos CPU e
11.37% menos tempo; venceu 10/11 pares.
O binário Rust cresceu 480 bytes. Os tamanhos são somente arquivos executáveis;
C/LLVM usam bibliotecas de sistema, incluindo zlib, que não entram nessa coluna.

## Equivalência e limites da comparação

- A nova build Rust passou em 38 contratos, com 26 renders byte-idênticos ao Bun.
- Nas 60 execuções da medição, Rust anterior/novo/Bun produziram o SHA256 PNG
  `4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6`.
- C/LLVM produziram o SHA256 PNG
  `a391875319f98a292c93ca4dff2de693c9769d7737ccda45f6ab3617a3d4f426`.
  Todos os CRCs, chunks não-IDAT e dados filtrados descomprimidos foram conferidos
  fora do trecho medido. Os pixels são iguais nesse input; os bytes comprimidos
  são diferentes. C/LLVM continuam reprovados na aceitação estrita de PNG.
- As diferenças de CPU C/LLVM/Rust incluem diferenças de codec. A alteração
  isolada Rust anterior/novo usa o mesmo codec, fonte gerado, dependências e flags.
- O fonte Rust gerado permaneceu byte-idêntico: SHA256
  `5b59f335ffd5682286c54daf0a5f5e23bcf6e3a45e82b36d3d8af0403df0ab59`.
  O dist do compilador e o lock do runtime também não mudaram.
- Não misturar estas medianas com a rodada diagnóstica antiga ou rodadas anteriores
  para atribuir ganhos. O comparativo relevante ao efeito da cópia é o par desta rodada.

## O que C/LLVM fazem e o que aproveitar

| Área | C/LLVM | Rust / ação |
| --- | --- | --- |
| Entrada da compressão | `scr_zlib.c` entrega `data->data` diretamente | Cópia eliminada para storage direto com `bytes_with_read_slice` |
| Saída da compressão | Buffer intermediário é copiado para ScrBytes | Vec final é transferido ao storage, sem cópia desse payload |
| Acesso a bytes | Ponteiros, refcount e dono de views | Rc/RefCell/Gc preservam identidade e aliases; emprestar regiões evita custo por byte |
| Filtro Paeth deste render | Código C ainda usa índices double | Rust já emite caminho com índices inteiros, slices e helper Paeth especializado |
| Tempo de vida | Liberação explícita gerada e refcounts | Próxima investigação: retenção além do último uso, com provas de aliases e liveness |

O render mantém aproximadamente 63,28 MiB nos buffers RGBA e filtrado. Consumir
apenas 20% da RAM do Bun deste teste exigiria eliminar/reutilizar buffers ou
processar em partes, além de retirar overhead do runtime. Não há evidência para
uma promessa de 20% em qualquer workload. Rust normalmente também usa LLVM via
rustc; este comparativo distingue os caminhos TS→Rust, TS→C e emissão LLVM direta.

## Validação e pendências

- Teste de ausência de cópia falhou no baseline, antes da correção.
- Runtime integrado: 225 testes passaram; Clippy com `-D warnings` passou.
- Corpus 1404, 2825 e novo 3144: 6 testes Rust/LLVM passaram; o harness LLVM
  executou também C contra Node. Rodada C/LLVM sanitizada: 3 testes passaram.
- Views diretas, subarrays, DataView sobre u8/u32, aliases, entrada vazia,
  níveis e liberação após unwind são cobertos nos testes do runtime.
- `git diff --check` e limites de linhas passaram.
- O gate completo **não está aprovado**: a rodada anterior parou em
  `2003-generic-methods-object-literal.ts`, com um helper genericFunc não emitível
  em C. Sanitizada completa ainda pendente. Não liberar antes de ambas passarem.

Próximos passos: resolver essa regressão do frontend, concluir os gates completos,
e medir retenção de buffers e custo do codec/filtro separadamente para escolher
as próximas otimizações do compilador. Não exigir reescrita do consumidor para
compensar desperdícios do nosso runtime.

## Evidências reproduzíveis

- Diretório: `/tmp/scriptc-zlib-borrow-20260909/`.
- `measurements/benchmark.json`: 60 amostras, fingerprints, condições e dispersão.
- `benchmark-png.mjs`, `png-spec.json`: harness específico que preserva hashes
  exatos por candidato e compara chunks/pixels entre codecs; o gate geral de
  igualdade byte a byte do repositório não foi modificado.
- `redwall/acceptance.json`, `redwall/contract.stderr`: build e contratos.
- `validation.json`, `red.log`, `integrated-runtime.log`, `clippy.log`,
  `differential.log`, `sanitized.log`: testes e fingerprints.
- Comparação de fontes e builds C/LLVM:
  `/tmp/scriptc-redwall-c-llvm-20260909/report.md`.

Atualização posterior: a regressão 2003 foi corrigida e passou nos diferenciais focados; o gate completo será repetido. Veja `tests/dogfood/native-undefined-probe.md`. Os números acima continuam referentes ao binário do checkpoint de compressão.
