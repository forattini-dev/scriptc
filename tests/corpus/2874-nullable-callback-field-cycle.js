// A JS callback field initialized to null keeps its callable arm static. Direct field calls work after a truthiness guard, and a listener capturing its owning instance remains visible to the native cycle collector.
class Handler {
  constructor(name) {
    this.name = name;
    this.callback = null;
  }

  installCallback() {
    this.callback = (value) => console.log(this.name, value);
  }

  run(value) {
    if (this.callback) return this.callback(value);
  }
}

const handler = new Handler("owner");
handler.installCallback();
handler.run("called");
