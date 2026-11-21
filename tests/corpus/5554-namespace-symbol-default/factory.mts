import { Payload, type Options } from './types.mts';
export default function factory(): Options {
  return { label: 'ready' };
}
export function withPayload(): Options {
  return { payload: new Payload() };
}
