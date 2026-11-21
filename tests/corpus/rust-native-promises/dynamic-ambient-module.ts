console.log("module:init");

export interface Api {
  value: number;
}

declare module "./dynamic-ambient-module.ts" {
  interface Api {
    label?: string;
  }
}

export const value = 42;
