export {};

const state = {
  count: 7,
  cleanup: /** @type {any} */ (null),
  dispose() {
    state.cleanup?.();
    state.cleanup = null;
  },
};

function install() {
  state.cleanup = function () {
    console.log(`cleanup:${this.count}`);
  };
}

install();
state.dispose();
state.dispose();
