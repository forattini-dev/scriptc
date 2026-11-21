let enabled = false;
let open = true;
let calls = 0;

function turnOn(): boolean {
  calls += 1;
  return true;
}

function turnOff(): boolean {
  calls += 10;
  return false;
}

const first = (enabled ||= turnOn());
const second = (enabled ||= turnOn());
const third = (open &&= turnOff());
const fourth = (open &&= turnOff());

console.log(first, second, third, fourth, enabled, open, calls);
