// @ts-nocheck
class Sync {
  constructor(name) {
    this.schedule = this.schedule.bind(this);
    this.name = name;
  }

  schedule(...args) {
    return `${this.name}:${args.join("+")}`;
  }
}

const sync = new Sync("native");
const detached = sync.schedule;
console.log(detached(2, 3));
