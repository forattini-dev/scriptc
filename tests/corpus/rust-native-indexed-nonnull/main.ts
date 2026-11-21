interface Question {
  readonly id: string;
  readonly title: string;
}

const steps: Question[] = [
  { id: "theme", title: "Theme" },
  { id: "agents", title: "Agents" },
];

let index = 0;
const stepIndex = (): number => index;
const step = (): Question => steps[stepIndex()]!;

console.log(step().id, step().title);
index = 1;
console.log(step().id, step() === steps[1]);

const byId = new Map<string, Question>(steps.map((question) => [question.id, question]));
const lookup = (id: string): Question => byId.get(id)!;
console.log(lookup("agents").title, lookup("theme") === steps[0]);

index = 5;
try {
  console.log(step().id);
} catch (error) {
  console.log("absent step", error instanceof TypeError);
}
try {
  console.log(lookup("missing").title);
} catch (error) {
  console.log("absent lookup", error instanceof TypeError);
}
