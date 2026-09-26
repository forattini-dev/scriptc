// ECMAScript #private slots are native-layout details, never enumerable own
// properties. A checked-dynamic write whose string key begins with '#' cannot
// read or overwrite the slot; ordinary class fields remain live.
class Vault {
  #secret = "original";
  publicValue = "before";

  reveal() {
    return this.#secret;
  }
}

const vault = new Vault();
const opaque = /** @type {unknown} */ (vault);
const view = opaque;

console.log("keys:", Object.keys(view).join(","));
console.log("json before:", JSON.stringify(view));

view["#secret"] = "hacked";
view.publicValue = "after";

console.log("state:", vault.reveal(), vault.publicValue);
