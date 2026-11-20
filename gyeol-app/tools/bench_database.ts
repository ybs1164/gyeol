/** DB-only burst benchmark. Uses disposable databases; never reads player data. */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { legal, replay } from '@gyeol/core';
import { Store } from '../packages/server/src/store';

const { values } = parseArgs({ options: { games: { type: 'string', default: '10,50,100' }, rounds: { type: 'string', default: '3' }, output: { type: 'string' } } });
const sizes = values.games!.split(',').map(Number), rounds = Number(values.rounds);
if (![...sizes,rounds].every(n => Number.isInteger(n) && n > 0 && n <= 1000)) throw new Error('Use positive integers <= 1000');
const percentile = (numbers: number[], q: number) => [...numbers].sort((a,b)=>a-b)[Math.min(numbers.length-1,Math.ceil(numbers.length*q)-1)];
const results = [];
for (const count of sizes) {
  const folder = mkdtempSync(join(tmpdir(),'gyeol-db-bench-'));
  const store = new Store(join(folder,'bench.sqlite'),true);
  const lag = monitorEventLoopDelay({ resolution: 1 });
  try {
    for (let i=0;i<count*2;i++) await store.call('seedPlayer', { id:`p${i}`,token:`fixture-${i}`,name:`fixture${i}`,
      rating:1500,rd:350,vol:.06,ranked:0,wins:0,losses:0,createdAt:Date.now(),seenAt:Date.now() });
    const games = [];
    for (let i=0;i<count;i++) games.push(await store.call('createGame',`p${i*2}`,`p${i*2+1}`,false,'daily'));
    const durations: number[] = [];
    lag.enable();
    const began = performance.now();
    for (let round=0;round<rounds;round++) {
      const { board,player } = replay(games[0].moves), action = legal(board,player)[0];
      await Promise.all(games.map(async(g,i)=>{
        const start=performance.now();
        const change=await store.call('applyMove',g.id,player===1?g.greenId!:g.brownId!,g.moves.length,action,g.revision);
        durations.push(performance.now()-start);
        if(change.error || !change.game) throw new Error('Benchmark move failed');
        games[i]=change.game;
      }));
    }
    const elapsedMs=performance.now()-began;
    lag.disable();
    results.push({ games:count, rounds, commands:durations.length, errors:0, elapsedMs,
      roundTripP50Ms:percentile(durations,.5),roundTripP95Ms:percentile(durations,.95),roundTripMaxMs:Math.max(...durations),
      eventLoopP95Ms:lag.percentile(95)/1e6,health:await store.call('health') });
  } finally { lag.disable(); await store.close(); rmSync(folder,{recursive:true,force:true}); }
}
const report={checkedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,node:process.version,
  workload:'DB-only bursts; no AI inference or WebSocket traffic; not a Raspberry Pi capacity result',results};
if(values.output) writeFileSync(values.output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
