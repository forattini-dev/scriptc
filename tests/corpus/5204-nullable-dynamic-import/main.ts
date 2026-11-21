async function load(enabled: boolean): Promise<void> {
  const policy = enabled ? await import("./policy.ts") : null;
  console.log(enabled && policy ? "present" : "missing");
  console.log(policy?.label() ?? "absent");
}

void load(true);
void load(false);
