import { readFile, writeFile } from "node:fs/promises";
import { fail } from "./fail.mjs";

export async function readJson(file) {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  } catch (error) {
    fail(`Cannot parse JSON file ${file}: ${error.message}`);
  }
}

export async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
