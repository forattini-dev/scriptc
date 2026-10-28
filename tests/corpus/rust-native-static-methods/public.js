let calls = 0;
export class Registry {
  static count(value = 1) { calls += 1; return value + calls; }
}
