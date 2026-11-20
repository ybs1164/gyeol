/** Run the current production web UI in an isolated browser, including the real Oracle endpoint. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createServer } from '../packages/server/src/server';

const root = fileURLToPath(new URL('../',import.meta.url));
const publicUrl = process.env.GYEOL_WEB_URL?.replace(/\/+$/, '');
const output = join(root,'tools/oracle-web-validation'); mkdirSync(output,{recursive:true});
const profile = mkdtempSync(join(tmpdir(),'gyeol-oracle-web-'));
const server = createServer({ port:0,host:'127.0.0.1',dbPath:null,staticDir:join(root,'apps/web/dist') });
const port = await server.listen();
const chrome = spawn(process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const pause = (ms:number) => new Promise(done=>setTimeout(done,ms));
let socket:WebSocket|undefined,next=0;
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
const results:any[]=[];
let current:any;
const call=(method:string,params:object={},sessionId?:string):Promise<any>=>new Promise((done,fail)=>{
  const id=++next,timer=setTimeout(()=>{pending.delete(id);fail(new Error(`CDP timeout ${method}`));},15000);
  pending.set(id,{resolve:value=>{clearTimeout(timer);done(value);},reject:error=>{clearTimeout(timer);fail(error);}});
  socket!.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
});
try {
  const endpoint=await new Promise<string>((done,fail)=>{
    let log='';const timer=setTimeout(()=>fail(new Error('Chrome startup timeout')),15000);
    chrome.once('error',e=>{clearTimeout(timer);fail(e);});
    chrome.stderr!.on('data',chunk=>{log+=String(chunk);const m=log.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);done(m[1]);}});
  });
  socket=new WebSocket(endpoint);
  socket.on('message',raw=>{
    const m=JSON.parse(String(raw));
    const job=pending.get(m.id);if(job){pending.delete(m.id);m.error?job.reject(new Error(m.error.message)):job.resolve(m.result);}
    if(!current)return;
    if(m.method==='Network.webSocketCreated')current.connections.push({requestId:m.params.requestId,url:m.params.url,handshake:null,welcome:false});
    const connection=current.connections.find((c:any)=>c.requestId===m.params?.requestId);
    if(m.method==='Network.webSocketHandshakeResponseReceived'&&connection)connection.handshake=m.params.response.status;
    if(m.method==='Network.webSocketFrameReceived'){
      try{const value=JSON.parse(m.params.response.payloadData);if(value.t==='welcome'&&connection)connection.welcome=true;}catch{}
    }
    if(m.method==='Network.webSocketFrameError'&&connection)current.networkErrors.push(m.params.errorMessage);
    if(m.method==='Runtime.exceptionThrown')current.exceptions.push(m.params.exceptionDetails.text);
  });
  await once(socket,'open');
  const {targetId}=await call('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Runtime.enable',{},sessionId);await call('Page.enable',{},sessionId);await call('Network.enable',{},sessionId);
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
  const evaluate=async(expression:string)=>{
    const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;
  };
  const wait=async(expression:string,timeout=12000)=>{
    const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(`Boolean(${expression})`))return;await pause(100);}
    throw new Error('UI did not render: '+expression);
  };
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`if(!localStorage.getItem('gyeol:settings'))localStorage.setItem('gyeol:settings',JSON.stringify({nickname:'WebConnectionCheck',lang:'ko',sound:false,vibrate:false,server:''}));`},sessionId);
  const scenarios = publicUrl ? [{ name:'oracle-public',address:'',timeout:10000 }] : [
    {name:'current-default',address:'',timeout:5000},
    {name:'oracle-http',address:'http://146.56.189.166:8787',timeout:20000},
    {name:'oracle-https',address:'https://146.56.189.166',timeout:10000},
  ];
  for(const test of scenarios){
    current={name:test.name,serverSetting:test.address,connections:[],networkErrors:[],exceptions:[]};
    if(results.length){await evaluate(`localStorage.setItem('gyeol:settings',JSON.stringify({...JSON.parse(localStorage.getItem('gyeol:settings')),server:${JSON.stringify(test.address)}}))`);}
    const began=Date.now();
    await call('Page.navigate',{url:`${publicUrl ?? `http://127.0.0.1:${port}`}/?connectionCheck=${test.name}#/`},sessionId);
    await wait(`location.search.includes(${JSON.stringify(test.name)}) && document.querySelector('.profile .who small') && !document.querySelector('.splash')`);
    while(Date.now()-began<test.timeout&&!current.connections.some((c:any)=>c.welcome)&&!current.networkErrors.length)await pause(200);
    current.elapsedMs=Date.now()-began;
    current.profileText=await evaluate(`document.querySelector('.profile .who small').textContent`);
    current.welcomeReceived=current.connections.some((c:any)=>c.welcome);
    const lobbyCapture=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},sessionId);
    writeFileSync(join(output,`${test.name}-lobby.png`),Buffer.from(lobbyCapture.data,'base64'));
    await evaluate(`location.hash='#/pvp'`);await wait(`document.querySelector('button.primary.play')`);
    current.playStatus=await evaluate(`document.querySelector('.status')?.textContent??null`);
    current.startDisabled=await evaluate(`document.querySelector('button.primary.play').disabled`);
    const capture=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},sessionId);
    writeFileSync(join(output,`${test.name}.png`),Buffer.from(capture.data,'base64'));
    results.push(current);
    console.log(JSON.stringify(current));
  }
  assert(results[0].welcomeReceived,'Current web must complete a WebSocket login');
  const settingsSource=readFileSync(join(root,'apps/web/src/screens/Settings.tsx'),'utf8');
  const report={checkedAt:new Date().toISOString(),appVersion:settingsSource.match(/APP_VERSION = '([^']+)'/)?.[1],
    browser:'headless Chrome',web:publicUrl ?? 'fresh production build',isolatedProfile:true,backend:publicUrl ? 'Oracle SQLite production' : 'local in-memory SQLite and explicit Oracle endpoints',results};
  writeFileSync(join(output,publicUrl ? 'public-report.json' : 'report.json'),JSON.stringify(report,null,2)+'\n');
}catch(error){console.error(error);process.exitCode=1;}
finally{
  const exited=chrome.exitCode===null?once(chrome,'exit').catch(()=>undefined):Promise.resolve();
  if(socket?.readyState===WebSocket.OPEN)await call('Browser.close').catch(()=>undefined);
  socket?.terminate();await Promise.race([exited,pause(3000)]);if(chrome.exitCode===null)chrome.kill();
  await server.close();
  const target=resolve(profile);if(dirname(target)===resolve(tmpdir())&&basename(target).startsWith('gyeol-oracle-web-')){
    try{rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}
  }
}
