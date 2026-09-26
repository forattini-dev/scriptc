let calls = 0;

function mark(label: string): void {
  calls++;
  console.log(label);
}

const choose = (first: boolean, second: boolean): void =>
  first ? mark("first") : second ? mark("second") : mark("third");

choose(true, false);
choose(false, true);
choose(false, false);

function chooseStatement(first: boolean, second: boolean): void {
  first ? mark("statement-first") : second ? mark("statement-second") : mark("statement-third");
}

chooseStatement(true, false);
chooseStatement(false, true);
chooseStatement(false, false);
console.log(calls);
