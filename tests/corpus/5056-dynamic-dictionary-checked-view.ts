interface Entry {
  kind: string;
}

const source: Record<string, unknown> = {
  first: { kind: "ok" },
};

const holder: { options?: Record<string, Entry> } = {
  options: source as Record<string, Entry>,
};

console.log(holder.options?.first?.kind);
