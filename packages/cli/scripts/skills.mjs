#!/usr/bin/env node

import process from "node:process";
import { dispatchSkills } from "../src/cli/skills-cli.mjs";

dispatchSkills(process.argv.slice(2), { io: console, cwd: process.cwd(), environment: process.env })
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
