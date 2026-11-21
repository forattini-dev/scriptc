let config = {
  enabled: false,
  retries: 2,
};

/** @param {any} enabled */
function setEnabled(enabled) {
  config.enabled = enabled;
}

setEnabled(true);
console.log(config.enabled);
console.log(config.retries);
