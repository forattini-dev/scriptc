// @rust-only
// @no-engine
// @ts-nocheck

type Chain = ((text: string) => string) & { tag: string };

function createChain(): Chain {
  function chain(text: any): any {
    return text;
  }
  chain.tag = "color";
  return chain;
}

function erasedFactory(): (value: any) => any {
  return createChain();
}

const value = erasedFactory()("READY") as string;
console.log(value);
