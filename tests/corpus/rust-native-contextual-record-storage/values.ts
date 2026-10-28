interface Budget { memory_max?: string; memory_high?: string }
interface Worker { id: string; warnings: string[]; budget?: Budget; extra?: number }
function inspect(workers: Worker[]): void {
  const worker = workers[0]!;
  const budget = worker.budget;
  if (!budget) return;
  const alias = workers[0]!;
  console.log('identity', worker === alias, worker.budget === budget);
  console.log('before', Object.keys(worker).join(','), Object.keys(budget).join(','), worker.id, budget.memory_max, worker.warnings.length);
  worker.warnings.push('warn');
  worker.extra = 7;
  budget.memory_high = '1G';
  console.log('after', Object.keys(worker).join(','), Object.keys(budget).join(','), worker.warnings[0], worker.extra, budget.memory_high);
}
const worker = { id: 'first', warnings: [], budget: { memory_max: '2G' } };
inspect([worker]);
