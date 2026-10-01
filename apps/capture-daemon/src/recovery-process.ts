import { spawn } from "node:child_process";
/** Credentials stay in the child environment; diagnostic output never includes libpq connection details. */
export async function runRecoveryPostgres(executable:string,args:readonly string[],connectionString:string,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<void>{
  if(options.signal?.aborted)throw new Error("Recovery command canceled before dispatch");
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(executable,[...args],{env:{PATH:process.env.PATH??"",PGDATABASE:connectionString,PGCONNECT_TIMEOUT:"5"},stdio:["ignore","ignore","pipe"],detached:process.platform!=="win32"});
    let terminated=false,bytes=0,killTimer:ReturnType<typeof setTimeout>|undefined;
    const kill=(signal:NodeJS.Signals)=>{if(child.pid===undefined)return;try{if(process.platform!=="win32")process.kill(-child.pid,signal);else child.kill(signal);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}};
    const abort=()=>{terminated=true;kill("SIGTERM");killTimer??=setTimeout(()=>kill("SIGKILL"),500);};
    const timer=setTimeout(abort,options.timeoutMs??120_000);options.signal?.addEventListener("abort",abort,{once:true});
    child.stderr.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024)abort();});
    child.once("error",()=>{clearTimeout(timer);options.signal?.removeEventListener("abort",abort);reject(new Error("Recovery PostgreSQL executable is unavailable"));});
    child.once("close",code=>{clearTimeout(timer);options.signal?.removeEventListener("abort",abort);if(killTimer!==undefined){clearTimeout(killTimer);kill("SIGKILL");}if(code===0&&!terminated)resolve();else reject(new Error(terminated?"Recovery PostgreSQL command canceled or exceeded limits":"Recovery PostgreSQL command failed"));});
  });
}
