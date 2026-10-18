export function make(repo, bin) {
  return { kind: "gh", repo, ...(bin ? { bin } : {}) };
}
