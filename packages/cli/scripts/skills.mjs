#!/usr/bin/env node

import process from "node:process";
import { runCli } from "../src/cli/dispatcher.mjs";

runCli({ io: console, cwd: process.cwd(), environment: process.env })
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
