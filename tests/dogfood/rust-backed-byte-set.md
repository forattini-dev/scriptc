# Cópia em bloco de views indiretas

O corpus da especialização numérica expôs uma falha independente no runtime:
`Buffer.from(new Uint32Array(16).buffer).set(new Uint8Array(64))` entrava em
panic ao escrever no vetor direto vazio da view. O armazenamento real estava
em `ByteBacking`, compartilhado com o array de palavras.

`bytes_set_from` agora obtém o snapshot da origem por `bytes_values`, que
respeita ambos os armazenamentos. Valida os limites antes de escrever e usa
o setter verificado quando o destino é indireto. O snapshot preserva cópias
sobrepostas nos dois sentidos e entre handles distintos da mesma memória.
O destino direto mantém a cópia de slice original, incluindo bits de NaN e -0.

O teste ponta a ponta encontrou o mesmo pressuposto incorreto em `bytes_join`.
Esse helper agora escolhe o iterador correto conforme o armazenamento. Não
adiciona snapshot/cópia dos bytes no caminho direto nem modifica a view.

## Validação

- Antes da correção, três dos quatro novos testes de runtime falharam por
  acesso ao storage direto vazio. O caso de float direto já passava.
- Depois: 222 testes do runtime + Clippy com warnings negados, toolchain 1.98.0.
- Corpus 3139 passou contra Node em Rust e em C/LLVM com sanitizers: origem e
  destino indiretos, subviews, sobreposição, cópia vazia, offsets fracionários,
  NaN, -0, falha de limites sem escrita parcial e storage Float64.
- Tetos de linhas e whitespace passaram. Nenhum unsafe introduzido.

- A rebuild do Redwall passou os 38 contratos, com 26 PNGs idênticos ao Bun.
  O Rust gerado é idêntico ao da etapa numérica; somente o runtime mudou.
  A rodada seguinte, com 11 amostras medidas por binário e ordem alternada,
  teve medianas Rust/Bun de 866,00/921,16 ms, CPU 0,85/0,91 s e RSS máximo
  111.240/143.836 KiB. Rust venceu 8/11 pares; todas as 24 saídas, incluindo
  aquecimento, foram iguais. Binário Rust: 4.069.616 bytes; Bun: 81.413.600.

O gate completo segue pendente. A falha de import dinâmico registrada no
baseline foi corrigida na etapa seguinte, descrita em
`rust-module-evaluation-rejections.md`.

Evidências: `/tmp/scriptc-backed-set-20260909/`.
