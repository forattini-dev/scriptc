export declare class Envelope {
  name: number;
  message: boolean;
  value: string;
  constructor(value: string);
}
export declare class Payload<T> {
  data: T;
  constructor(data: T);
}
