// @rust-only
// @no-engine
// @transform-types
class Settings {
  constructor(
    public count = 7,
    readonly label = "default",
    private secret = count + 1,
    protected enabled = true,
    public note?: string,
  ) {
    console.log("body", this.count, this.label, this.secret, this.enabled, this.note);
    count = count + 10;
    console.log("local", count, this.count);
  }
  describe(): string { return `${this.label}:${this.secret}:${this.enabled}`; }
}
const first = new Settings();
const alias = first;
alias.count = 21;
console.log("default", first.count, first.describe(), first.note === undefined);
const second = new Settings(2, "custom", 9, false, "present");
console.log("supplied", second.count, second.describe(), second.note);
const third = new Settings(undefined, "explicit");
console.log("undefined", third.count, third.describe());
class Store {
  constructor(readonly entries: number[], public state: { name: string }) {}
}
const entries = [1, 2];
const state = { name: "before" };
const store = new Store(entries, state);
entries.push(3);
state.name = "after";
console.log("owning", store.entries === entries, store.entries.length, store.state === state, store.state.name);
