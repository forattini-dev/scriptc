export function make(group) { return { values: ["a"], label: "js", ...(group !== undefined ? { group } : {}) }; }
export function copy(input) { return { ...input }; }
