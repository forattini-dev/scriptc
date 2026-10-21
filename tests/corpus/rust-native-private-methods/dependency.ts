export class Imported {
  #read(): number { return 12; }
  value(): number { return this.#read(); }
}
export const Named = class Inner {
  #read(): number { return 20; }
  value(): number { return this.#read(); }
};
