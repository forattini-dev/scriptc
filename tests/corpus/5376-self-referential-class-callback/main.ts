class TokenList {
  private afterUpdate: (value: TokenList) => void;

  constructor(afterUpdate: (value: TokenList) => void = () => undefined) {
    this.afterUpdate = afterUpdate;
  }

  update(): void {
    this.afterUpdate(this);
  }
}

let seen = false;
const list = new TokenList((value) => {
  seen = value instanceof TokenList;
});
list.update();
console.log(seen);
