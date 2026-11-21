interface Choice {
  key: string;
  answer?: string;
}

interface Question {
  id: string;
  choices: Choice[];
}

function selected(steps: readonly Question[]): string[] {
  return steps
    .find((candidate) => candidate.id === "target")
    ?.choices.filter((choice) => choice.answer === "apps")
    .map((choice) => choice.key) ?? [];
}

console.log(selected([{ id: "target", choices: [{ key: "one", answer: "apps" }, { key: "two" }] }]).join(","));
console.log(selected([]).length);
