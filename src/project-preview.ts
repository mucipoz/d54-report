import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';

// Only use recognized local binaries or a simple Node server declaration.
export async function startProject(root:string, manifest:string) {
  let scripts:Record<string,string>;
  try { scripts=JSON.parse(manifest).scripts ?? {}; } catch { return; }
  const entry=['dev','start'].find(k=>typeof scripts[k]==='string' && /^(?:vite(?:\s|$)|next (?:dev|start)(?:\s|$)|astro dev(?:\s|$)|node [\w./-]+\.[cm]?js$)/.test(scripts[k]));
  if (!entry) return;
  const socket=createServer();
  await new Promise<void>((resolve,reject)=>{ socket.once('error',reject); socket.listen(0,'127.0.0.1',resolve); });
  const port=String((socket.address() as AddressInfo).port);
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const script=scripts[entry];
  const args=script.startsWith('node ') ? [] : ['--',script.startsWith('next ') ? '--hostname':'--host','127.0.0.1','--port',port];
  if (script.startsWith('vite')) args.push('--strictPort');
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,PORT:port,HOST:'127.0.0.1',CI:'1',BROWSER:'none',NEXT_TELEMETRY_DISABLED:'1'};
  for (const key of ['HOME','TMPDIR','SystemRoot','USERPROFILE','APPDATA']) if (process.env[key]) env[key]=process.env[key];
  const child=spawn('npm',['run',entry,...args],{cwd:root,env,stdio:'ignore',detached:process.platform!=='win32'});
  let exited=false;
  child.once('error',()=>{exited=true;});
  child.once('exit',()=>{exited=true;});
  const terminate = () => {
    if (!child.pid) return;
    try {
      if (process.platform!=='win32') process.kill(-child.pid,'SIGKILL');
      else { const kill=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'}); kill.on('error',()=>{child.kill();}); }
    } catch { /* Group already exited. */ }
  };
  process.once('exit',terminate);
  const close=async () => { process.off('exit',terminate); terminate(); };
  const url='http://127.0.0.1:'+port;
  const deadline=Date.now()+15_000;
  while (!exited && Date.now()<deadline) {
    try {
      const r=await fetch(url,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(700)});
      await r.body?.cancel();
      if (r.status<500) return {url,close};
    } catch { /* App may still be compiling. */ }
    await delay(150);
  }
  await close();
  throw Error('Yerel uygulama ayrılan portta hazır olmadı.');
}
