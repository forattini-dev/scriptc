function make(): () => number {
  if (true) {
    const wrapper = (): number => later();
    function otherWrapper(): number {
      return later() + mutableLater;
    }
    const value = 7;
    let mutableLater = 1;
    function later(): number {
      return value;
    }
    mutableLater = 2;
    return (): number => wrapper() + otherWrapper();
  }
  throw new Error("unreachable");
}

console.log(make()());
