import { sealPrivateRoots, withPrivateRootWrite } from '../../dist/index.js';
import { writeFile } from 'node:fs/promises';
const [mode,root]=process.argv.slice(2);
if(mode==='seal'){
  const seal=await sealPrivateRoots([{root,writers:['capture']}]);
  process.send?.({ready:true});
  process.on('message',async()=>{await seal.release();process.exit(0);});
}else if(mode==='write'){
  await withPrivateRootWrite(root,'capture',async()=>{process.send?.({ready:true});await new Promise(resolve=>process.once('message',resolve));await writeFile(`${root}/ack`,'durable');});
  process.exit(0);
}
