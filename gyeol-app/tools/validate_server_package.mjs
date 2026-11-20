/** Exercise the exact release files against a disposable DB, never the operator's DB. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const release = resolve(process.argv[2] ?? 'packages/server/dist');
const staticDir = resolve(process.env.PACKAGE_STATIC ?? join(release,'public'));
const folder = mkdtempSync(join(tmpdir(),'gyeol-package-check-'));
const database = join(folder,'check.sqlite');
async function run(file,args,env={}) {
  const p = spawn(process.execPath,[file,...args],{env:{...process.env,...env},stdio:'inherit',windowsHide:true});
  const [code] = await once(p,'exit'); if (code !== 0) throw new Error(`Package check failed (${code})`);
}
let server;
try {
  await run(join(release,'db-cli.mjs'),['migrate','--db',database]);
  server = spawn(process.execPath,[join(release,'server.mjs')],{env:{...process.env, DB_PATH:database, STORAGE:'sqlite', DATA:'',
    PORT:'0', HOST:'127.0.0.1', STATIC:staticDir, AI_DIR:process.argv.includes('--ai') ? staticDir : 'off',
    MAINTENANCE_FILE:join(folder,'maintenance')},stdio:['ignore','pipe','inherit'],windowsHide:true});
  const port = await new Promise((done,fail) => {
    let output = '';
    const timer = setTimeout(()=>fail(new Error('Package server startup timed out')),30000);
    server.stdout.on('data',chunk=>{output+=String(chunk);const m=output.match(/localhost:(\d+)/);if(m){clearTimeout(timer);done(Number(m[1]));}});
    server.once('error',error=>{clearTimeout(timer);fail(error);});
    server.once('exit',()=>{clearTimeout(timer);fail(new Error('Package server exited during startup'));});
  });
  await run(join(release,'smoke.mjs'),[`http://127.0.0.1:${port}`,...(process.argv.includes('--ai') ? ['--ai'] : [])]);
  const stopped=once(server,'exit'); server.kill('SIGTERM'); await stopped; server=undefined;
  await run(join(release,'db-cli.mjs'),['backup','--db',database,'--output',join(folder,'backup.sqlite')]);
  console.log('Release package, worker, migrations, game flow and backup/restore passed.');
} catch(error) { console.error(error.message); process.exitCode=1; }
finally {
  if(server && server.exitCode===null && server.signalCode===null){const stopped=once(server,'exit');server.kill('SIGKILL');await stopped;}
  rmSync(folder,{recursive:true,force:true});
}
