// @ts-nocheck
function makeClass() {
  class Local {
    read() {
      return Local.answer;
    }

  }

  Local.answer = 42;
  return Local;
}

const Local = makeClass();
const value = new Local();
console.log(value.read());
