const inputs = ['[]', '["text"]', '[null]', '[false]', '[0]', '[7]', '[{"n":1}]', '[[1]]'];
let reads = 0;
function index() { reads++; return 0; }
for (let round = 0; round < 4; round++) {
  for (const input of inputs) {
    const values = JSON.parse(input) as string[];
    reads = 0;
    try {
      const kind = typeof values[index()];
      const truth = values[index()] ? 'truthy' : 'falsy';
      console.log(round, kind, truth, JSON.stringify(values[index()]), typeof values[7], reads);
    } catch (error) {
      console.log(round, 'caught', error instanceof TypeError, reads);
    }
  }
}
