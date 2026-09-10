# Rejeições internas da avaliação de módulos

O gate plain falhava em `dynamic import() keeps a failed module rejected`:
o programa capturava e imprimia o erro duas vezes, como Node, mas terminava
com `UnhandledPromiseRejection: Error: broken module evaluation`.

A avaliação V8 cria uma promessa interna, observada pelo carregador. Seu
erro é encaminhado ao resultado do host ou à promessa de `import()` recebida
pelo programa. Essa promessa interna ficava sem handler; rejeições síncronas
também já tinham entrado na fila de avisos antes de `evaluate()` retornar.

Agora o carregador marca a promessa interna como tratada antes de drenar as
microtasks e remove da fila somente uma entrada com sua identidade exata.
Mantém a promessa no cache de avaliação, preservando top-level await, ciclos,
estado rejeitado e identidade do erro nos imports seguintes. As promessas
recebidas pelo programa continuam sujeitas ao mecanismo de rejeição não tratada.

## Validação

- Baseline do contrato reproduziu saída correta com exit code 1 indevido.
- Os três novos testes do engine falharam antes da correção. Um import
  ignorado produzia duas rejeições, quando somente a promessa do programa
  deveria ser reportada.
- Depois, os 12 testes do engine V8 passaram, incluindo cache de código,
  módulos cíclicos, top-level await e os novos controles de erro.
- Os 17 contratos do compilador para módulos passaram. O import capturado
  exige stderr vazio; o import ignorado exige exit code 1 e um único aviso.
- O teste de erro assíncrono verifica identidade do erro após reimportar.
  O teste de rejeição em background confirma que ela continua sendo reportada.
- Clippy do crate V8 com warnings negados, ESLint e whitespace passaram.

Não há novo unsafe, mudança no caminho sem engine do Redwall ou supressão
global de avisos. O gate completo plain/sanitized ainda está pendente.
Evidências: `/tmp/scriptc-module-evaluation-rejection-20260909/`.
