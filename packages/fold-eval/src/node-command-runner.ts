import { exec } from "node:child_process";

import type { CommandRunner } from "./command.js";

export const nodeCommandRunner: CommandRunner = (request) =>
  new Promise((resolve, reject) => {
    exec(
      request.command,
      {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        timeout: request.timeoutMs,
        maxBuffer: request.maxBufferBytes,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
