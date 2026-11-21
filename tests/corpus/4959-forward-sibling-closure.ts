// @rust-only
// @no-engine
const run = (callback: () => void) => callback();

const dispatch = () => {
  const first = () => second();
  const second = () => console.log("ready");
  run(first);
};

dispatch();
