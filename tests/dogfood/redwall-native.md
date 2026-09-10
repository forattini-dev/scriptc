# Redwall: tamanho e execução nativa (2026-09-09)

O Redwall é um componente executável de red-dev que ficou fora do inventário
inicial de 43 entradas. Este complemento testa o artefato vendorizado e o
renderer original com uma chamada externa, sem editar o consumidor.

## Artefato vendorizado

`red-dev/vendor/redwall-bin/redwall` é um ELF Linux x64 de **1.866.856 bytes**
(1,87 MB decimal, 1,78 MiB), ainda com símbolos. Seu script de build usa
`scriptc build ... --dynamic`, sem fixar o backend Rust, e reescreve cópias
dos módulos para contornar limitações. O executável contém `JS_NewRuntime`,
`JS_Eval2` e símbolos `scr_*`; depende de libz, libm e libc. Portanto, não é
prova de Rust sem engine JavaScript. Fontes e wallpapers são assets externos
nesse caminho; o tamanho do ELF não representa todo o pacote instalado.

Uma renderização do tema dark, 3840x2160, workers=3, demais campos ausentes,
foi executada com um núcleo, limite de memória de 3 GiB e sem swap. Comparação
com chamada do renderer original por Bun, no mesmo dia civil e mesmos inputs:

| Medição | Artefato vendorizado | Fonte por Bun |
|---|---:|---:|
| Tempo de parede | 2,00 s | 0,86 s |
| CPU de usuário | 1,90 s | 0,77 s |
| Pico RSS | 93.000 KiB (90,82 MiB) | 188.952 KiB (184,52 MiB) |
| PNG | 239.076 bytes | 170.524 bytes |
| Dimensões | 3840x2160 | 3840x2160 |

Os PNGs têm **zero pixels diferentes**, mas os bytes dos arquivos diferem.
O PNG vendorizado é 40,2% maior neste caso. A medição foi uma execução por
caminho, limitada em recursos: não mede cold start isolado, não é benchmark
estatístico nem prova de equivalência para outros temas/estados. Os números
4 MB RSS e 10 ms nos comentários do consumidor não descrevem esta renderização.
O artefato antigo e os fontes atuais não têm proveniência de build idêntica;
a diferença de compressão não identifica, sozinha, um bug no compilador atual.

A inspeção do build encontrou uma causa concreta: as linhas 142–152 de
`scripts/build-redwall-bin.sh` removem `{ level: 9 }` de `deflateSync`.
Os streams descomprimidos (incluindo filtros PNG) são idênticos. Recompressão
com zlib local 1.3 nível 6 reproduz exatamente os 239.019 bytes IDAT do vendor.
Nível 9 local gera 197.921 bytes, ainda diferente dos 170.467 bytes do Bun:
a implementação da biblioteca também afeta o fluxo comprimido. O runtime Rust
atual já possui `zlib_deflate_sync_level`; o próximo teste deve preservar a
opção original, e não perpetuar o workaround de build do consumidor.
`compression-analysis.json` registra a comparação. Nenhum consumidor foi editado.

## Rust sem engine, fontes originais

Uma entrada externa chama `renderRedwall` e `yearProgress` dos módulos originais
por symlink relativo, lê os mesmos assets e fornece os mesmos inputs. O tsconfig
foi copiado byte a byte e node_modules aponta para a instalação do consumidor.
Nenhuma das reescritas do build vendorizado foi aplicada.

`backend: rust`, `allowEngine: false`, `npmStatic: auto`, `target: bun`:
**775 instruções, duas falhas/diagnósticos, zero instruções island, zero runtime
fences reportadas**. Build recusada nas duas ocorrências de
`new Date(ano, mês, dia)` em `yearProgress` (SC2020). Isso é ausência de lowering
do compilador. Não significa que a geração Rust e os contratos já passaram:
novas barreiras podem aparecer depois dessas recusas.

Tentativas preliminares tinham configuração incompleta (317 diagnósticos) e
imports absolutos classificados como pacotes (duas recusas). Elas foram
corrigidas no chamador externo, sem alterar o consumidor. O resultado acima
é a tentativa `redwall-original-relative`, não essas tentativas de montagem.

## Evidência

`.red/tmp/redwall-audit-20260909/` conserva o chamador, hashes dos fontes e
artefato, build/análise estruturados, stdout/stderr, `/usr/bin/time -v`, PNGs
e comparação por `decodePng` original. A fonte inicial fica em
`/tmp/scriptc-redwall-audit-20260909/`; seus symlinks apontam para os consumidores.

Prioridade: suportar o construtor Date por componentes com semântica local
correta (incluindo overflow, anos 0–99 e transições de fuso), compilar este
renderer sem adaptações e medir release/size com paridade antes de comparar
contra Bun e o artefato antigo. O caller usado aqui não é a aplicação inteira.

## Rust nativo verificado após Date por componentes (2026-09-09)

O compilador agora aceita o construtor local Date por componentes nos três
backends. O cálculo compartilha MakeDay/MakeTime com Date.UTC, preserva a
ordem avaliação/conversão dos argumentos, defaults, normalização de calendário,
anos 0–99, NaN e TimeClip depois da conversão para UTC. A seleção de offsets
cobre sobreposição de horários, saltos de meia hora e o dia omitido em Apia.
Os dados históricos de fuso continuam sendo os do OS, conforme a limitação
existente; o teste não finge que Amsterdam pré-1970 usa os mesmos dados do ICU.
Para datas antigas, verifica campos civis em todos os fusos e instantes exatos
em UTC. Os casos modernos mantêm comparação exata de todos os campos/instantes.

O chamador original que exercita yearProgress e renderRedwall gerou Rust com
engine none, externalFfi false e zero fences. A execução dev atingiu 60 segundos
sem concluir; a release (4.151.592 bytes) produziu o PNG dark 3840x2160 idêntico
byte a byte ao Bun: 170.524 bytes. Nessa amostra levou 11,83 s e pico de
103.980 KiB. O caso e a configuração diferem do benchmark repetido abaixo.

O adaptador reutilizável gerado por scripts/prepare-native-redwall.mjs importa
os fontes originais, recebe tema/estado/calendário/assets por JSON e permite
exercitar os contratos do consumidor sem editar nenhum fonte. Os **38 testes**
existentes de redwall-render.test.ts passaram: **26 chamadas de renderRedwall**
foram executadas pelo binário Rust, com comparação byte a byte contra a
implementação original em Bun e auditoria de heap. Os testes de helpers do
mesmo arquivo continuam exercitando esses helpers em Bun; não são contados
como chamadas nativas. A matriz dedicada de Date cobre o calendário nativamente.

### Benchmark do mesmo renderer standalone

Três amostras medidas por candidato, uma de aquecimento, ordem alternada,
um núcleo, teto de 3 GiB, sem swap, processos novos. Tema obsidian e estado
fixos de fixture.ts, mesmos assets externos. Ambas as entradas são o mesmo
adaptador TS: Rust release e Bun --compile. stdout, stderr, status e PNG são
idênticos em todas as oito execuções (incluindo aquecimentos).

| Medida | Rust | Bun compilado |
|---|---:|---:|
| Executável | 4.088.384 bytes | 81.413.600 bytes |
| Tempo mediano | 3.767,43 ms | 569,97 ms |
| CPU mediana | 3,75 s | 0,56 s |
| Pico RSS mediano | 110.740 KiB | 131.548 KiB |

Rust é 95,0% menor em disco, usa 15,8% menos pico RSS e demora 6,61 vezes mais
neste caso. Isso não é superioridade geral e não mede o red-dev inteiro. Os
assets externos não entram no tamanho dos executáveis de nenhum candidato.

Uma segunda sonda, com dark e timers nas chamadas originais, mediu decode
4328 ms, encode 2754 ms e render completo 5420 ms em Rust; em Bun, 258/420/633 ms.
Os dois PNGs da sonda (imagem reencodada e renderizada) são idênticos entre os
candidatos. Esses tempos de uma amostra servem para localizar etapas; não são
somados nem tratados como benchmark independente. O fonte Rust emitido revela
clones de handles em cada acesso de byte e conversões ToInt32 com módulo em
ponto flutuante. São candidatos para experimentos separados, não causas
quantificadas ainda. Não foi alterado código de performance neste checkpoint.

### Validação e limites restantes

Build e lint passaram (zero erros, 3122 avisos); Clippy Rust 1.98.0 com
-D warnings e todos os 201 testes do runtime passaram. A matriz de seis fusos
passou nos três backends (18 execuções); C/LLVM passaram também com sanitizers
(12 execuções), além de oito comparações sanitizadas dos quatro corpora de Date.
Os quatro corpora Rust selecionados passaram. Os dois novos baselines foram
registrados/verificados. O snapshot stdlib-fence passou após remover somente a
recusa do construtor agora suportado. Limites de arquivos foram reduzidos por
extração: lower-classes 5555→5525, validate 5697→5672, nunca elevados.

O gate completo plain/sanitized do repositório ainda não foi aceito. As 16
falhas da suíte ampla de baselines registradas no checkpoint UTF-16 continuam
pendentes; nenhum snapshot amplo foi regravado para escondê-las. O objetivo de
confiar/deployar os projetos completos permanece ativo. Este checkpoint prova
o componente renderer e sua fronteira JSON nas condições exercitadas, não o
red-dev inteiro, todos os erros de entrada, empacotamento ou instalação final.

Evidência persistida: `.red/tmp/native-date-redwall-checkpoint-20260909/` com
WIP, hashes, contratos, benchmark, PNGs e binários. A auditoria inicial e as
recusas antes da correção acima são histórico, não o estado atual do renderer.


## Experimento de conversão numérica (2026-09-09)

ToInt32 no runtime Rust passou a extrair os bits IEEE-754 do double em vez de
usar resto em ponto flutuante. O teste independente cobre todos os expoentes,
ambos os sinais, seis limites de mantissa e 100.000 padrões adicionais.
Os 202 testes do runtime e Clippy passaram no Rust fixado 1.98.0; oito corpora
Rust selecionados passaram, incluindo o novo 3118. O novo corpus passou também
em C/LLVM sanitizados e seu baseline foi registrado/verificado isoladamente.
O limite de linhas passou. A mudança preserva forbid(unsafe_code).

A reconstrução do renderer passou novamente nos 38 testes existentes, com
26 invocações nativas comparadas byte a byte com Bun. O Rust gerado tem o mesmo
SHA-256 antes/depois; somente o runtime mudou. Os dois binários de aplicação
foram compilados com rustc 1.97.1, conforme seus recibos de aceitação; a validação
do runtime acima usa explicitamente a versão fixada 1.98.0. Nenhum fonte do
consumidor mudou entre os recibos e a verificação final.

Nova comparação intercalada, três amostras medidas e um aquecimento por
candidato, mesmo adaptador/input/assets, um núcleo e 3 GiB sem swap:

| Medida | Rust anterior | Rust com conversão por bits | Bun compilado |
|---|---:|---:|---:|
| Executável (bytes) | 4.088.384 | 4.080.856 | 81.413.600 |
| Tempo mediano (ms) | 3.775,09 | 3.829,10 | 582,63 |
| CPU mediana (s) | 3,76 | 3,82 | 0,57 |
| Pico RSS mediano (KiB) | 110.852 | 110.836 | 131.120 |

As 12 execuções produziram os mesmos stdout/stderr/status e PNG de 108.881 bytes
(SHA-256 4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6).
Este input obsidian difere do dark de 170.524 bytes da auditoria inicial.

**Não houve ganho demonstrado no renderer.** A mediana do experimento foi
1,43% mais lenta, com tempos de 3674–3918 ms contra 3760–3788 ms anteriormente;
três amostras não estabelecem significância estatística. O microbenchmark
isolado melhorou conversões, mas isso não prova melhoria da aplicação.
Mantemos o experimento no WIP com essa limitação explícita. O executável novo
é 95,0% menor que Bun e o pico RSS mediano é 15,5% menor, mas o tempo é 6,57x
maior. Assets externos ficam fora do tamanho de ambos os executáveis.

O próximo experimento de performance deve medir os clones de handles e acessos
a bytes emitidos nos loops, preservando ordem de avaliação e snapshots do
receiver quando argumentos têm efeitos. Nenhuma eliminação de clones foi
implementada neste passo. O gate completo plain/sanitized continua pendente;
esses resultados não aprovam release, deploy ou o red-dev inteiro.

Recibos: `.red/tmp/native-numeric-redwall-checkpoint-20260909/`, incluindo
benchmark com hashes dos binários, contratos, integridade do consumidor,
logs de validação e snapshot do WIP.


## Revalidação após correções de frontend (2026-09-09)

O descarte de projetos TS7 e a captura de closures genéricas foram corrigidos
no compilador. O Redwall reconstruído mantém os 38 testes, 26 chamadas nativas
com PNG idêntico ao Bun, engine none, externalFfi false e zero fences. O Rust
gerado e o runtime não mudaram; não há nova afirmação de ganho de renderização.
Nenhum fonte ou binário instalado do consumidor foi substituído. Recibos em
.red/tmp/native-ts7-lifecycle-checkpoint-20260909/; detalhes e gates pendentes
em tests/dogfood/ts7-lifecycle-gate.md.

## Execução isolada do artefato (2026-09-09)

O executável aceito após as correções de frontend foi copiado e seu SHA-256
revalidado antes e depois do teste. Uma execução em Bubblewrap expôs somente
o pacote de entrada, um diretório de saída, dispositivos/proc temporários e
seis bibliotecas específicas do sistema. O ambiente foi limpo, PATH apontou
para um diretório inexistente e os namespaces de rede/processos foram isolados.
Não havia checkout, node_modules, fontes TS, compilador ou instalações de
Node/Bun no filesystem visível à execução Rust. O pacote de entrada foi montado
somente para leitura. A auditoria de heap permaneceu habilitada.

O mesmo isolamento executou o Bun --compile existente como referência,
trocando apenas o executável e o diretório de saída. Ambos terminaram com
status zero, stdout/stderr vazios e PNG de 108.881 bytes idêntico byte a byte
(SHA-256 4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6).
Isso também coincide com o hash do benchmark Obsidian anterior. Os tempos
dessa sonda não são um novo benchmark: a suíte completa concorria na máquina.

| Componente da cópia isolada | Bytes |
|---|---:|
| Executável Rust | 4.080.856 |
| Wallpaper Obsidian | 52.123 |
| Fonte reduzida | 6.860 |
| Configuração JSON da sonda | 754 |
| Total, sem bibliotecas do sistema | 4.140.593 |

O ELF é Linux x86_64 PIE, stripped, sem RPATH/RUNPATH. Declara libgcc_s, libm,
libc e o loader como dependências; o maior símbolo de glibc exigido é
`hypot@GLIBC_2.35`. Essa é uma restrição de distribuição do artefato atual,
não prova de execução em outra distribuição ou arquitetura. A sonda usou as
bibliotecas do host, cujos hashes foram registrados. libpthread/libdl também
ficaram disponíveis para a referência Bun. Não houve teste em glibc 2.35 real
nem produção de um binário estático/musl neste passo.

O resultado prova relocação e independência do checkout para este adaptador,
seu tema e sua configuração. Não representa o pacote completo de temas, a CLI
original, instalação, todos os inputs ou aprovação para deploy do red-dev.
Nenhum fonte do compilador/runtime/testes executáveis ou consumidor foi alterado
neste passo. O gate completo plain continua em execução; sanitized ainda não
foi iniciado. Evidência reproduzível e recibos:
`.red/tmp/native-redwall-portability-checkpoint-20260909/`.

## Experimento isolado: leituras de bytes sem clones locais (2026-09-09)

Uma cópia do Rust gerado foi alterada em 35 chamadas `bytes_get`: o primeiro
argumento passa a emprestar o handle local diretamente, removendo seu clone
temporário. A cópia de controle preserva exatamente o Rust anteriormente
aceito. Ambas foram compiladas pelo mesmo driver Rust em release, com features
de runtime vazias e `allowEngine: false`. Nenhum fonte do emissor, runtime ou
consumidor foi alterado para este experimento; a transformação textual não é
uma implementação de otimização no compilador.

A variante passa nos 38 testes existentes do renderer, com 26 chamadas nativas
comparadas byte a byte contra Bun e auditoria de heap habilitada. Os 116 fontes
do recibo anterior mantêm os hashes, assim como o runtime e Cargo.lock. Os
executáveis da sonda usam rustc 1.97.1, a mesma versão do recibo anterior.

Sete amostras medidas e um aquecimento por candidato, ordem alternada, um CPU,
3 GiB sem swap, processos novos e auditoria de heap habilitada nos nativos:

| Medida | Controle Rust | Variante com empréstimos | Bun compilado |
|---|---:|---:|---:|
| Executável (bytes) | 4.080.856 | 4.074.936 | 81.413.600 |
| Tempo mediano (ms) | 10.713,63 | 9.456,42 | 1.659,35 |
| CPU mediana (s) | 10,13 | 8,76 | 1,55 |
| Pico RSS mediano (KiB) | 110.848 | 110.960 | 143.892 |

As 24 execuções têm os mesmos stdout, stderr, status e PNG de 108.881 bytes
(SHA-256 4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6).
A mediana observada da variante é 11,7% menor em tempo e 13,5% menor em CPU
que o controle da mesma rodada. O pico de RAM não melhorou.

Houve forte variação de desempenho na máquina: controle 8.557–11.031 ms,
variante 4.894–9.666 ms e Bun 913–1.787 ms. Uma validação do Commander corria
em outro cgroup durante parte da sonda. Estes números não devem ser comparados
diretamente com o benchmark anterior de 3,83 s, nem tratados como ganho
consolidado do backend. A variante continua muito mais lenta que Bun aqui.

O próximo passo para essa hipótese é implementar empréstimos no emissor sob
condições explícitas de segurança, preservando snapshots do receiver e ordem
de avaliação quando índices/chamadas têm efeitos. Devem existir regressões
para reatribuição via callbacks, capturas, aliases e leituras após await; o
sucesso da transformação neste renderer não autoriza remover clones em geral.
Evidências: `.red/tmp/native-borrowed-reads-checkpoint-20260909/`.


## Índices inteiros no emissor Rust (2026-09-09)

A análise compartilhada de loops canônicos, antes utilizada apenas por C/LLVM,
agora também orienta a geração de Rust. O contador fica em `usize`; usos comuns
continuam observando um `number` e acessos diretos usam helpers com limites
verificados. Esta implementação chega a dois loops deste renderer: entrada do
CRC e conversão de cobertura dos glifos em alpha. Os clones de handles e os
demais loops permanecem como antes. Detalhes: `rust-integer-loops.md`.

O novo executável passou novamente nos 38 testes, com 26 chamadas nativas e PNGs
idênticos ao Bun. Engine `none`, `externalFfi: false`, zero fences. Todos os 116
hashes dos fontes analisados permaneceram iguais; nenhum binário do consumidor
foi instalado ou substituído.

Sete amostras medidas e um aquecimento por candidato, ordem alternada, mesmo
input Obsidian/assets, processos novos, afinidade ao CPU lógico 5, quota de um
CPU e 3 GiB sem swap. As próprias suítes haviam terminado; outros trabalhos
continuavam na máquina. O controle recompila o Rust gerado anterior contra o
mesmo runtime atual e com o mesmo rustc 1.97.1, sem alterações textuais.

| Medida | Controle Rust | Rust com índices inteiros | Bun compilado |
|---|---:|---:|---:|
| Executável (bytes) | 4080856 | 4081624 | 81413600 |
| Tempo mediano (ms) | 4300.47 | 4299.63 | 659.19 |
| CPU mediana (s) | 4.28 | 4.28 | 0.64 |
| Pico RSS mediano (KiB) | 111188 | 111112 | 140952 |

**Nenhum ganho de velocidade demonstrado no Redwall:** a diferença de mediana
é de -0.019% (menos de um milissegundo). As faixas foram
4226–5859 ms no controle e
4236–4962 ms na variante.
CPU e RAM ficaram essencialmente iguais. O binário cresceu 768 bytes.
As 24 execuções preservaram stdout/stderr/status e PNG de 108881 bytes,
SHA-256 `4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6`.
Não comparar os tempos absolutos com rodadas anteriores de configuração distinta.

Build do workspace, quatro testes unitários, dois corpora Rust com auditoria
de heap, quatro comparações C/LLVM sanitizadas, 205 testes do runtime e Clippy
all-targets com `-D warnings` passaram. O gate completo permanece não aceito,
com a falha anterior de rejeição em importação dinâmica ainda pendente.
Evidências: `.red/tmp/native-integer-loops-checkpoint-20260909/`.


### Sonda de custo por etapa

`perf record` foi recusado pelo kernel (`perf_event_paranoid=4`); a configuração
do sistema não foi alterada. Uma cópia de diagnóstico do Rust gerado recebeu
somente temporizadores nas fronteiras das funções. Ela fica em `profile.rs`
no diretório de evidências, separada do compilador e do executável aceito.
Wrappers de zlib iniciam o timer após a avaliação dos argumentos, para separar
a filtragem do PNG da compressão propriamente dita.

Três amostras após um aquecimento, mesma entrada e núcleo, heap audit habilitado:

| Rotina | Mediana inclusiva (ms) |
|---|---:|
| Desfazer filtros PNG (`unfilter`) | 524.65 |
| Converter pixels (`toRgba`) | 985.48 |
| Aplicar filtros de saída (`filtered`) | 1758.17 |
| Compressão zlib | 201.86 |
| Descompressão zlib | 3.68 |
| CRC, soma das chamadas | 6.41 |
| Renderização completa, inclui as etapas acima | 3540.03 |

As três rotinas de pixels somam aproximadamente 92.7% do tempo de
renderização (mediana da proporção calculada em cada amostra). Zlib fica perto
de 6%. Isso localiza a próxima investigação nas rotinas de pixels; **não separa
quanto custa conversão numérica, clone, acesso ao heap ou checagem de limites**.
O CRC é pequeno nesta entrada, coerente com a ausência de ganho demonstrado
pela primeira otimização.

As quatro saídas PNG da sonda têm o mesmo hash do artefato aceito. Os tempos
instrumentados não são um novo benchmark de velocidade e não devem ser
comparados com os 4,30 s da rodada sem instrumentação. As durações de funções
pai incluem as dos filhos; não somar decode/encode/render com suas subetapas.
O próximo passo é analisar intervalos inteiros e efeitos para índices derivados
(linha, stride e coluna) e testar empréstimos de buffers nas rotinas dominantes,
sem trocar semântica JS por casts irrestritos.


## Empréstimos de buffers locais no emissor Rust (2026-09-09)

A remoção de clones agora está implementada no compilador, usando os tipos e
os efeitos admitidos pela análise do IR. Ela não depende da transformação
textual experimental anterior. No renderer, 56 pontos de leitura/consulta de
tamanho de buffers locais passam a emprestar o handle. Escritas continuam
usando o snapshot anterior. Detalhes e condições: `rust-byte-borrows.md`.

O Redwall foi reconstruído em release e passou nos 38 testes existentes,
com 26 chamadas nativas e PNGs idênticos ao Bun. Engine `none`, FFI externa
`false`, zero fences, auditoria de heap habilitada. O controle é a build Rust
anterior com índices inteiros. O Bun 1.4.1 foi compilado novamente da mesma
entrada com `bun build --compile`; seu hash ficou idêntico ao anterior.
Todos os 116 hashes dos fontes analisados permaneceram iguais. Nenhum fonte
ou binário instalado no consumidor foi alterado.

Sete amostras medidas e um aquecimento por executável, ordem alternada,
mesmo input/assets, processos novos, afinidade ao CPU lógico 2, quota de um
CPU, 3 GiB sem swap. As próprias suítes haviam terminado; outros trabalhos
continuavam na máquina. A comparação executa diretamente os três binários.

| Medida | Bun compilado | scriptc anterior | scriptc com empréstimos |
|---|---:|---:|---:|
| Executável (bytes) | 81413600 | 4081624 | 4072504 |
| Tempo mediano (ms) | 830.34 | 5813.65 | 5218.30 |
| CPU mediana (s) | 0.82 | 5.80 | 5.20 |
| Pico RSS mediano (KiB) | 137792 | 111312 | 111228 |

O ganho observado é **10.2% menos tempo mediano** e
10.3% menos CPU que o controle na mesma rodada.
O executável diminuiu 9120 bytes; RAM ficou
essencialmente igual. A nova build foi mais rápida em 5 das
sete comparações por rodada. As faixas foram
5233–7178 ms no controle e
4678–6218 ms na nova build: há variação
relevante, portanto estes números não demonstram um ganho estável em todos os
cenários. Não comparar os tempos absolutos com os 4,30 s de outra rodada/core.
**A nova build ainda demora 6.28 vezes o Bun compilado** neste
input. A mudança não resolve a diferença de performance da aplicação.

As 24 execuções preservaram stdout, stderr, status e PNG de 108881 bytes,
SHA-256 `4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6`.
SHA-256 do executável Rust aceito:
`7d714b38598fe386823094dc20ee3ef594611f0a3dd50d32bcf30b795dc3e080`.

Build do workspace e lint passaram. A validação focada cobre 15 corpora Rust
com auditoria de heap e oito testes unitários; após a guarda para valores já
avaliados, três corpora e os oito unitários passaram novamente. Os corpora
1409/3123/3124 passaram em C/LLVM sanitizados; a versão final do 3124 passou
novamente nos dois. O runtime não foi alterado neste passo.

A investigação também reproduziu, com a otimização desligada, três objetos
vivos quando um gerador é abandonado após seu último yield. A reprodução ficou
preservada; a nova suíte verifica conclusão normal do gerador. Esse problema e
a falha anterior de rejeição em importação dinâmica seguem pendentes. O gate
global não foi aceito; isto não aprova instalação do CLI original completo.
Evidências: `.red/tmp/native-byte-borrows-checkpoint-20260909/`.

## Empréstimos nas escritas de buffers (2026-09-09)

O emissor agora reutiliza a prova conservadora de estabilidade do receiver
para `bytesSet`, analisando índice e valor antes de permitir o empréstimo.
Foram eliminados clones em 24 pontos de escrita do Rust gerado (contagem
estática). Os sete pontos restantes com receiver local conservam o snapshot.
Os três caminhos usam a mesma guarda para valores já pré-avaliados: leituras,
escritas e condição dos loops inteiros. Nenhum runtime ou fonte do consumidor
foi alterado. Detalhes e reproduções: `rust-byte-write-borrows.md`.

A nova build release passou nos mesmos 38 testes do renderer, com 26 chamadas
nativas e PNGs idênticos ao Bun. Engine `none`, FFI externa `false`, zero fences,
auditoria de heap ativa e os mesmos 116 hashes de fontes analisados. Continua
sendo o renderer pela entrada adaptadora TS; o CLI original completo e o
binário instalado no consumidor não foram substituídos.

O controle Rust é a build anterior com empréstimos nas leituras. O Bun 1.4.1
foi recompilado da mesma entrada com `bun build --compile` e preservou seu hash.
Foram feitas duas rodadas: sete e onze amostras medidas por executável, cada
qual com um aquecimento, invertendo a ordem inicial na segunda. Ambas alternam
candidatos, executam processos novos e usam os mesmos input/assets, CPU lógico
2, quota de um CPU, limite de 3 GiB e nenhum swap. Nossas suítes terminaram
antes da medição; outras tarefas do usuário continuaram na máquina.

| Rodada / medida | Bun compilado | scriptc anterior | scriptc com escritas emprestadas |
|---|---:|---:|---:|
| 1: Tempo mediano (ms) | 1025.74 | 5141.79 | 5528.81 |
| 1: CPU mediana (s) | 1.01 | 5.12 | 5.52 |
| 1: Pico RSS mediano (KiB) | 144588 | 111244 | 111164 |
| 2: Tempo mediano (ms) | 827.23 | 5226.79 | 5007.72 |
| 2: CPU mediana (s) | 0.80 | 5.21 | 4.99 |
| 2: Pico RSS mediano (KiB) | 126364 | 111168 | 111196 |
| Executável (bytes) | 81413600 | 4072504 | 4067736 |

A primeira rodada deu **7,5% mais tempo mediano** para a nova build; a segunda,
**4,2% menos**. Ela venceu 4/7 e 8/11 comparações por rodada, respectivamente.
Não há ganho consistente de mediana demonstrado por estas duas rodadas. Na
segunda, a nova build ainda demora **6,05 vezes o Bun compilado**. O tamanho
caiu 4.768 bytes; RAM do Rust ficou essencialmente igual. Os resultados não
são uma vitória de performance nem justificam substituir a build instalada.

Todas as 60 execuções preservaram stdout, stderr, status e PNG de 108881 bytes,
SHA-256 `4d351ba412958507f0d266c76aebb64e83ff6eebaf9ab0a8886ee99ec5e065c6`.
Executável Rust novo:
`ec59e31a307a402eeb53c922a16021abe57c62aec8a8cc35cee0ab9ae1d0745f`.
Rust gerado:
`4216628e914ed9471d72bdd91bb202a10927d80722f4e58e5853b14c9a1ad053`.

A validação focada reuniu 16 corpora Rust, 13 testes unitários e 8 execuções
C/LLVM sanitizadas. As sondas descobriram limitações anteriores: construções
não admitidas no frontend, suspensão dentro de uma atribuição de byte e
escritas com índice inválido que encerram a execução. As duas últimas foram
reproduzidas com a otimização desligada. Não foram corrigidas nem ocultadas;
os testes finais isolam os caminhos atualmente admitidos.

O próximo candidato à investigação é a alocação de `JsCell<f64>` para `recon`
em cada iteração do loop de unfilter. `cell_empty()` chama `Gc::new`, embora
a variável seja numérica local. Ainda é preciso provar quando sua inicialização
e os caminhos de exceção permitem armazenamento na pilha e medir o efeito.
Índices calculados e acessos por fatias continuam pendentes.

O gate completo continua não aceito por causa da falha anterior de rejeição
em importação dinâmica. Evidências e amostras:
`.red/tmp/native-byte-writes-checkpoint-20260909/` e
`/tmp/scriptc-byte-writes-20260909/`.


## 2026-09-09: slices de leitura e conversão especializada para u8

O backend agora elimina máscaras `& 255` redundantes em stores u8, empresta
entradas de loops após analisar os efeitos das chamadas e usa conversão
numérica especializada no runtime. Os detalhes e testes estão em
`rust-byte-store-masks.md`, `rust-byte-read-regions.md` e `rust-u8-conversion.md`.

A rodada mais recente usa sete amostras e um aquecimento por executável,
mesma entrada e assets, ordem alternada, CPU 2 e os mesmos limites. Medianas:

| Executável | Tempo | Pico RSS | Bytes do binário |
| --- | ---: | ---: | ---: |
| Rust anterior (byte-write borrows) | 5416,03 ms | 111164 KiB | 4067736 |
| Rust com slices de leitura | 2827,35 ms | 111100 KiB | 4063256 |
| Rust atual com conversão u8 | 2657,00 ms | 110952 KiB | 4063984 |
| Bun --compile recompilado | 1046,69 ms | 136984 KiB | 81413600 |

O candidato atual reduziu 50,9% da mediana do artefato antigo nesta rodada;
ainda demora **2,54 vezes o Bun**. As 32 execuções preservaram bytes de saída,
status e PNG. O ganho isolado da conversão caiu de 18,9% na triagem curta para
6,0% nesta repetição: o ruído da máquina impede extrapolar a primeira rodada.

A única diferença de arquivo analisado entre o artefato antigo e o atual é
o campo version do package.json (1.0.131 → 1.0.132); o código do renderizador
permanece idêntico. O Bun reconstruído hoje tem o mesmo SHA-256 do anterior.

A nova build passou nos 38 contratos, com 26 chamadas nativas e auditoria de
heap. O runtime passou em 214 testes e Clippy. Binário atual:
`8a3467ebc28c0353822b11bf6d4af2cf3e1562644446c1a1abeeb6339f8c19db`.
Evidências: `/tmp/scriptc-u8-conversion-20260909/measurements-seven/`.
A meta de performance e o gate completo plain/sanitized continuam abertos.
