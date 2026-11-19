import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

async function localFile(root:string, path:string) {
  const full=await realpath(path).catch(()=>undefined);
  if (!full) return;
  const rel=relative(root,full);
  if (!rel || isAbsolute(rel) || rel==='..' || rel.startsWith('..'+sep)) return;
  if ((await stat(full)).isFile()) return full;
}

// Resolve supported package scripts to a local Node entry point and literal arguments.
export async function previewCommand(root:string, manifest:string) {
  let scripts:Record<string,string>;
  try { scripts=JSON.parse(manifest).scripts ?? {}; } catch { return; }
  for (const key of ['dev','start']) {
    const script=scripts[key];
    if (typeof script!=='string' || !/^[\w./:=+@ -]+$/.test(script)) continue;
    const [name,...args]=script.trim().split(/ +/);
    if (args.some(arg=>arg.split('/').includes('..') || isAbsolute(arg))) continue;
    if (name==='node' && args.length===1 && !args[0]!.startsWith('-') && /\.[cm]?js$/.test(args[0]!)) {
      const entry=await localFile(root,resolve(root,args[0]!));
      if (entry) return {entry,args:[],name};
    }
    if (name!=='vite' && !(name==='next' && ['dev','start'].includes(args[0]!)) && !(name==='astro' && args[0]==='dev')) continue;
    const pkg=await localFile(root,join(root,'node_modules',name,'package.json'));
    if (!pkg) continue;
    const {bin}=JSON.parse(await readFile(pkg,'utf8'));
    const file=typeof bin==='string' ? bin : bin?.[name];
    if (typeof file!=='string') continue;
    const entry=await localFile(root,resolve(dirname(pkg),file));
    if (!entry) continue;
    const flags:string[]=[];
    for (let i=0;i<args.length;i++) {
      const token=args[i]!;
      if (/^(?:--host(?:name)?|--port|-H|-p)(?:=|$)/.test(token)) {
        if (!token.includes('=') && args[i+1] && !args[i+1]!.startsWith('-')) i++;
      } else if (token!=='--strictPort') flags.push(token);
    }
    return {entry,args:flags,name};
  }
}

export async function startProject(root:string, manifest:string) {
  const command=await previewCommand(await realpath(root),manifest);
  if (!command) return;
  const socket=createServer();
  await new Promise<void>((resolve,reject)=>{ socket.once('error',reject); socket.listen(0,'127.0.0.1',resolve); });
  const port=String((socket.address() as AddressInfo).port);
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const args=[command.entry,...command.args];
  if (command.name!=='node') args.push(command.name==='next'?'--hostname':'--host','127.0.0.1','--port',port);
  if (command.name==='vite') args.push('--strictPort');
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,PORT:port,HOST:'127.0.0.1',CI:'1',BROWSER:'none',NEXT_TELEMETRY_DISABLED:'1'};
  for (const key of ['HOME','TMPDIR','SystemRoot','USERPROFILE','APPDATA']) if (process.env[key]) env[key]=process.env[key];
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:'ignore',detached:process.platform!=='win32'});
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
