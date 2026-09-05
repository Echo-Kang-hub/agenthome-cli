import process from "node:process";
import { runCli } from "./dispatcher.mjs";

export function start(forcedAgent) {
  runCli({ forcedAgent })
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
    });
}
