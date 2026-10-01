import { constants } from "node:fs";
import { chmod, lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncPrivateDirectory } from "./storage.js";

/** Call only inside the enrolled root seal. SQLite backup includes committed WAL pages. */
export async function backupTelemetrySqlite(root:string,target:string):Promise<void>{
  const path=join(root,"outbox.sqlite"),before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink()||await realpath(path)!==path||before.size>256*1024*1024)throw new Error("Telemetry database is not a bounded physical file");
  // Exclusive reservation prevents backup()'s overwrite behavior from replacing a prior artifact.
  const reserved=await open(target,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await reserved.close();
  const {DatabaseSync,backup}=await import("node:sqlite");
  const source=new DatabaseSync(path,{readOnly:true});
  try {await backup(source,target,{rate:128});}finally{source.close();}
  const after=await lstat(path);if(before.dev!==after.dev||before.ino!==after.ino)throw new Error("Telemetry database was replaced during backup");
  const copy=new DatabaseSync(target);
  try {
    const check=copy.prepare("PRAGMA quick_check").get();if(check?.quick_check!=="ok")throw new Error("Telemetry backup failed SQLite integrity check");
    // Claims belong to the original database process, not to restored encrypted batches.
    // API command stamps remain unchanged, so a lost delivery acknowledgement replays idempotently.
    copy.exec("UPDATE batches SET lease=NULL,lease_until=0; PRAGMA wal_checkpoint(TRUNCATE)");
  }finally{copy.close();}
  await chmod(target,0o600);const file=await open(target,"r");try{await file.sync();}finally{await file.close();}await syncPrivateDirectory(dirname(target));
}
