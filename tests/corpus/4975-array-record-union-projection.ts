type Expectation =
  | { readonly kind: "host"; readonly what: string }
  | { readonly kind: "file"; readonly path: string };

interface Plan {
  readonly expect?: readonly Expectation[];
}

const editors = ["code", "cursor"];
const plan: Plan = {
  expect: editors.map(
    (editor) => ({ kind: "host", what: `extension (${editor})` }) as const,
  ),
};

console.log(plan.expect !== undefined);
