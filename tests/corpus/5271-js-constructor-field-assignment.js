class Cell {
  value;

  /** @param {string[]} initial */
  constructor(initial) {
    this.value = initial;
  }

  get current() {
    return this.value;
  }
}

/** @param {string[]} initial */
function accessor(initial) {
  const cell = new Cell(initial);
  return () => cell.current;
}

const content = accessor(["a", "b", "c"]);
console.log(content().length);
