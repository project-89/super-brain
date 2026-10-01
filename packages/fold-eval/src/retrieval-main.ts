import { retrievalCli } from "./retrieval-cli.js";

try {
  console.log(await retrievalCli(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Retrieval evaluation failed");
  process.exitCode = 1;
}
