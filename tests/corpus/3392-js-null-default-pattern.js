// @rust-only
// @no-engine
class Client {
  id;
  constructor({ id = null, payload }) {
    this.id = id ?? "generated";
    console.log(this.id, payload);
  }
}
new Client({ id: "explicit", payload: 1 });
new Client({ payload: 2 });
new Client({ id: undefined, payload: 3 });
new Client({ id: null, payload: 4 });
