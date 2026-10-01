import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sealPrivateRoots, withPrivateRootWrite } from "../src/private-fence.js";
const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() }; };

it("seals acknowledged writes and rejects aliases, unregistered or legacy writer roots", async () => {
  const base = await mkdtemp(join(tmpdir(),"private-fence-")), root=join(base,"root");
  try {
    await withPrivateRootWrite(root,"capture",()=>writeFile(join(root,"ack"),"durable"));
    const seal=await sealPrivateRoots([{root,writers:["capture"]}]);
    await expect(withPrivateRootWrite(root,"capture",async()=>{})).rejects.toThrow(/sealed/);
    const alias=join(base,"alias"); await symlink(root,alias);
    await expect(withPrivateRootWrite(alias,"capture",async()=>{})).rejects.toThrow(/sealed/);
    await seal.release();
    await expect(sealPrivateRoots([{root,writers:["hook-relay"]}])).rejects.toThrow(/omits|enrolled/);
    await expect(sealPrivateRoots([{root,writers:["capture"]},{root:alias,writers:["capture"]}])).rejects.toThrow(/distinct/);
    const legacy=join(base,"legacy"); await withPrivateRootWrite(legacy,"capture",async()=>{});
    await writeFile(join(root,"external"),"old");
    const unsupported=join(base,"unsupported"); const {mkdir}=await import("node:fs/promises"); await mkdir(unsupported); await writeFile(join(unsupported,"old"),"legacy");
    await withPrivateRootWrite(unsupported,"capture",async()=>{});
    await expect(sealPrivateRoots([{root:unsupported,writers:["capture"]}])).rejects.toThrow(/legacy/);
  } finally { await rm(base,{recursive:true,force:true}); }
});
it("keeps an in-flight nested descendant claimed and reacquires for a late descendant", async () => {
  const root=await mkdtemp(join(tmpdir(),"private-fence-descendant-"));
  const nestedStarted=deferred(), nestedDone=deferred(), parentReturned=deferred(), lateStart=deferred();
  let nested!:Promise<void>, late!:Promise<void>;
  try {
    const parent=withPrivateRootWrite(root,"capture",async()=>{
      nested=withPrivateRootWrite(root,"capture",async()=>{nestedStarted.resolve(); await nestedDone.promise;});
      late=(async()=>{await lateStart.promise; await withPrivateRootWrite(root,"capture",async()=>{});})();
      parentReturned.resolve();
    });
    await parentReturned.promise; await nestedStarted.promise;
    let sealed=false; const sealing=sealPrivateRoots([{root,writers:["capture"]}]).then(value=>{sealed=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,30)); expect(sealed).toBe(false);
    nestedDone.resolve(); await nested; await parent; const seal=await sealing;
    lateStart.resolve(); await expect(late).rejects.toThrow(/sealed/); await seal.release();
  } finally { nestedDone.resolve(); lateStart.resolve(); await rm(root,{recursive:true,force:true}); }
});

it("drains a real producer and recovers a crashed fence owner without taking over a live one", async()=>{
  const {fork}=await import("node:child_process");const {fileURLToPath}=await import("node:url");
  const base=await mkdtemp(join(tmpdir(),"private-fence-process-")),root=join(base,"root");
  await withPrivateRootWrite(root,"capture",async()=>{});
  const childPath=fileURLToPath(new URL("./fixtures/private-fence-process.mjs",import.meta.url));
  const writer=fork(childPath,["write",root],{stdio:["ignore","ignore","pipe","ipc"]});
  let owner:ReturnType<typeof fork>|undefined;
  try{
    await once(writer,"message");
    let acquired=false;const sealing=sealPrivateRoots([{root,writers:["capture"]}]).then(value=>{acquired=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,30));expect(acquired).toBe(false);
    writer.send("finish");await once(writer,"exit");const seal=await sealing;await seal.release();
    owner=fork(childPath,["seal",root],{stdio:["ignore","ignore","pipe","ipc"]});await once(owner,"message");
    await expect(withPrivateRootWrite(root,"capture",async()=>{})).rejects.toThrow(/sealed/);
    owner.kill("SIGKILL");await once(owner,"exit");
    await withPrivateRootWrite(root,"capture",()=>writeFile(join(root,"recovered"),"new claim"));
    const next=await sealPrivateRoots([{root,writers:["capture"]}]);await next.release();
  }finally{writer.kill("SIGKILL");owner?.kill("SIGKILL");await rm(base,{recursive:true,force:true});}
},10_000);
