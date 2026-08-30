interface Birth {
  readonly project: string;
  readonly index: number;
}

const rounds: Birth[][] = [
  [{ project: "alpha", index: 0 }, { project: "beta", index: 0 }],
  [],
  [{ project: "alpha", index: 1 }],
];

const births = rounds.flat();
console.log(births.length);
for (const birth of births) {
  console.log(birth.project, birth.index);
}

const labels = ["alpha", "beta"];
const labelCopy = labels.flat();
labelCopy.push("gamma");
console.log(labels.length, labelCopy.join(","));
