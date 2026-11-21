class Target extends EventTarget {}

const target = new Target();
console.log(target instanceof Target, target instanceof EventTarget);
