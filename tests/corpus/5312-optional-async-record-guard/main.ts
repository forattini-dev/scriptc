import { navigate, update, type Screen } from './screen.js';

const sync: Screen = { id: 'sync', onBeforeExit: () => false };
const asynchronous: Screen = {
  id: 'async',
  onBeforeExit: async () => {
    console.log('guard');
    return true;
  },
};

async function main(): Promise<void> {
  update({ set: value => console.log('cell', value) });
  console.log(await navigate(sync));
  console.log(await navigate(asynchronous));
  console.log(await navigate(null));
}

void main();
