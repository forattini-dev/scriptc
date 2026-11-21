import { AsyncResource } from "node:async_hooks";

class Scope extends AsyncResource {
  constructor() {
    super("scriptc-test");
  }

  invoke(value: number): number {
    return this.runInAsyncScope(function (this: { bias: number }, left: number, right: number) {
      return this.bias + left + right;
    }, { bias: 4 }, value, 3);
  }
}

const scope = new Scope();
console.log(scope.invoke(2), scope instanceof Scope, scope instanceof AsyncResource);
