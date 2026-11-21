type SourceValue = string | number | boolean | null | SourceValue[] | SourceObject;
type SourceObject = { [key: string]: SourceValue };
type TargetValue = string | number | boolean | null | TargetValue[] | TargetObject;
type TargetObject = { [key: string]: TargetValue };

type Crusher = (items: readonly TargetValue[], limit: number) => {
  items: TargetValue[];
  total: number;
};

function crush(items: readonly SourceValue[], limit: number): {
  items: SourceValue[];
  total: number;
} {
  return { items: items.slice(0, limit), total: items.length };
}

function summarize(items: readonly TargetValue[], crusher: Crusher = crush): string {
  const result = crusher(items, 1);
  return `${result.total}:${JSON.stringify(result.items)}`;
}

console.log(summarize([{ status: "first" }, { status: "second" }]));
