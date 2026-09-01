interface ValueFlagSpec<T> {
  coerce: (raw: string) => T;
}

function mapValues(items: string[], spec: ValueFlagSpec<unknown>): unknown[] {
  return items.map((item) => spec.coerce(item));
}

const values: Record<string, unknown> = {};
values.items = mapValues(["alpha", "beta"], {
  coerce: (raw: string) => raw.toUpperCase(),
});

console.log((values.items as string[]).join(","));
