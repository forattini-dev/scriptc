import data from "./asset.json" with {type: "json"};
export function current(): unknown { return data; }
export function mutate(): void { data.count = 7; data.nested.label = "updated"; }
