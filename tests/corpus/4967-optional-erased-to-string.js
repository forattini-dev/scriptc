// @rust-only
// @no-engine

/** @param {any} options */
function display(options = {}) {
  const { default: value } = options;
  return value?.toString();
}

void display({ default: 12 });
void display({});
