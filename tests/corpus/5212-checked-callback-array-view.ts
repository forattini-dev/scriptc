interface Wizard {
  count(): number;
  completedSteps(): number[];
}

const raw = {
  count: (): unknown => 2,
  completedSteps: (): unknown[] => [1, 2],
};

const wizard = raw as Wizard;
console.log(`${wizard.count()}:${wizard.completedSteps().join(",")}`);
