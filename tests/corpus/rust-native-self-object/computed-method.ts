const dispose = Symbol("dispose");

function makeState() {
  const state = {
    value: 3,
    [dispose]() {
      console.log("dispose", state.value);
      state.value = 4;
    },
    read() {
      return state.value;
    },
  };

  console.log("value", state.read());
}

makeState();
