const log: string[] = [];
const prototype: any = {
  get toString() {
    log.push(`get:${this.marker}`);
    return function (this: any) {
      log.push(`call:${this.marker}`);
      return this.marker;
    };
  },
};
const value: any = Object.create(prototype);
value.marker = 'child';
const array: any[] = [value];
console.log((array as string[]).join('|'), log.join(','));
