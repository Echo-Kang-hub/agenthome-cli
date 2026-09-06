import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  addDirectSkills,
  addSkillsToPacks,
  assertSafeId,
  assertSafeSkillName,
  buildCatalog,
  catalogDisplayName,
  cloneHead,
  cloneRevision,
  createInstallContext,
  createTempDirectory,
  deriveSourceId,
  discoverSourceSkills,
  ensureCatalog,
  fail,
  findSource,
  installCopies,
  installPacks,
  installedPackIds,
  isCatalogDirectory,
  isInside,
  loadDefaultCatalogSpec,
  loadKnownCatalogs,
  loadPacks,
  loadSources,
  parsePackArguments,
  previousManagedState,
  printTree,
  pruneCatalogSkills,
  readDirectState,
  readJson,
  registerCatalog,
  registerKnownCatalog,
  registerSource,
  remoteHead,
  removeAllManagedSkills,
  removeDirectSkills,
  removeEmptyDirectory,
  removeExternalSkills,
  removeInstallationFiles,
  removeSkillDirectories,
  removeTempDirectory,
  replaceStagedFiles,
  resolveInstallSource,
  resolvePack,
  resolvePacks,
  saveSources,
  setDefaultCatalogSpec,
  skillCoveredByPacks,
  skillsInstallationStatus,
  stageSource,
  stateRoot,
  uninstallPacks,
  writeInstallMetadata,
  writeJson,
} from "#core";
import { updateAvenic } from "./self-update.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function takeOption(argumentsList, option) {
  const index = argumentsList.indexOf(option);
  if (index === -1) {
    return null;
  }
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${option} requires a value`);
  }
  argumentsList.splice(index, 2);
  return value;
}

function parseScopeArguments(argumentsList) {
  const globalFlags = new Set(["-g", "--global"]);
  const global = argumentsList.some((argument) => globalFlags.has(argument));
  return {
    argumentsList: argumentsList.filter((argument) => !globalFlags.has(argument)),
    global,
  };
}

async function commandInstall(explicitPacks = [], options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  const { resolvedPacks } = await installPacks(context, explicitPacks, {
    io,
    onPlan: (resolved) => {
      printTree(resolved.groups, "Skill Installation Plan", [
        `Packs: ${resolved.packs.map((pack) => pack.name).join(" + ")}`,
        `Scope: ${context.label}`,
        `Root: ${context.root}`,
        `Duplicate selections removed: ${resolved.duplicateSelections}`,
      ], io);
    },
  });
  io.log(`\nInstallation complete: ${resolvedPacks.names.length} unique Skills`);
  io.log(`Config: ${context.configFile}`);
  io.log(`Lock:   ${context.lockFile}`);
}

async function commandAddDirect(argumentsList, options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  if (!options.global && isCatalogDirectory(options.cwd ?? process.cwd())) {
    fail("Run installation from a work project, not from the Avenic catalog");
  }
  const [sourceReference, ...skillNames] = argumentsList;
  if (!sourceReference) {
    fail("Usage: avenic skills add <owner/repo> [skill...] [-g]");
  }
  const unknownOption = argumentsList.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    fail(`Unknown option: ${unknownOption}`);
  }
  const result = await addDirectSkills(context, sourceReference, skillNames, { io });
  if (result.alreadyInstalled) {
    return;
  }
  io.log(`\nInstalled direct Skills: ${result.names.join(", ")}`);
  io.log(`Source: ${result.sourceId} @ ${result.revision.slice(0, 8)}`);
  io.log(`Config: ${context.configFile}`);
  io.log(`Lock:   ${context.lockFile}`);
}

async function commandUninstall(packArguments, options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  const current = await installedPackIds(context);
  if (!current) {
    io.log(`No managed ${context.label.toLowerCase()} Skills installation found`);
    return;
  }

  if (packArguments.length === 0) {
    const managed = await previousManagedState(context);
    const directState = await readDirectState(context);
    const directNames = directState.directSources.flatMap((source) => source.skills);
    if (directNames.length > 0) {
      await removeDirectSkills(context, directNames);
      await removeSkillDirectories(context, directNames, io);
    }
    const total = await removeAllManagedSkills(context, managed, io);
    await removeInstallationFiles(context);
    if (options.global) {
      await removeEmptyDirectory(stateRoot(options.environment));
    }
    io.log(`Uninstalled all managed ${context.label.toLowerCase()} Skills: ${total}`);
    return;
  }

  const result = await uninstallPacks(context, packArguments, {
    io,
    onPlan: (resolved, removedPacks) => {
      printTree(resolved.groups, "Skill Uninstall Plan", [
        `Remove Packs: ${removedPacks.join(" + ")}`,
        `Keep Packs: ${resolved.packs.map((pack) => pack.name).join(" + ")}`,
        `Scope: ${context.label}`,
        `Root: ${context.root}`,
      ], io);
    },
  });
  if (result.current === null) return;
  if (result.skippedCommon) {
    io.log("Skipped: common is always included");
  }
  if (result.absent.length > 0) {
    io.log(`Already absent: ${result.absent.join(", ")}`);
  }
  if (!result.changed) {
    io.log("No Pack changes");
    return;
  }
  io.log(`\nUninstall complete: ${result.removed.join(", ")}`);
}

async function commandUninstallSkill(skillArguments, options = {}) {
  const io = options.io ?? console;
  if (skillArguments.length === 0) {
    fail("Usage: remove <skill...> [-g]");
  }
  const skillNames = [...new Set(skillArguments)];
  const context = createInstallContext(options.global ?? false, options);
  const result = await removeExternalSkills(context, skillNames, { io });
  io.log(
    result.removedDirectories > 0 || result.directRemoved.length > 0
      ? `Removed external Skills: ${skillNames.join(", ")}`
      : `Already absent: ${skillNames.join(", ")}`,
  );
}

async function commandTree(packArguments, options = {}) {
  const io = options.io ?? console;
  const catalogInfo = await resolveInstallSource(options);
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, path.join(catalogInfo.catalogRoot, "skills"));
  if (packArguments.length === 0) {
    printTree(catalog.groups, "All catalog Skills", [], io);
    return;
  }
  const packs = await loadPacks(catalogInfo.catalogRoot);
  const resolvedPacks = resolvePacks(
    catalog,
    sourceConfig,
    packs,
    parsePackArguments(packArguments),
  );
  printTree(resolvedPacks.groups, "Pack Preview", [
    `Packs: ${resolvedPacks.packs.map((pack) => pack.name).join(" + ")}`,
    `Duplicate selections removed: ${resolvedPacks.duplicateSelections}`,
  ], io);
}

async function commandPacks(options = {}) {
  const io = options.io ?? console;
  const catalogInfo = await resolveInstallSource(options);
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, path.join(catalogInfo.catalogRoot, "skills"));
  const packs = await loadPacks(catalogInfo.catalogRoot);
  io.log("\nAvailable Packs\n");
  for (const pack of packs.values()) {
    const own = resolvePack(catalog, sourceConfig, pack);
    const effective = resolvePacks(catalog, sourceConfig, packs, [pack.id]);
    const count = pack.id === "common" ? `${own.names.length}` : `${own.names.length} + common = ${effective.names.length}`;
    io.log(`- ${pack.id.padEnd(12)} ${count.padStart(18)} Skills  ${pack.name}`);
    if (pack.description) {
      io.log(`  ${pack.description}`);
    }
  }
  io.log();
}

async function commandStatus(options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  const status = await skillsInstallationStatus(context);
  if (!status) {
    fail(`${context.label} scope has no lock file; install a Pack first`);
  }
  printTree(status.groups, `Current ${context.label} Skills`, [
    `Packs: ${status.packs.map((pack) => pack.name ?? pack.id ?? pack).join(" + ")}`,
  ], io);
  for (const targetConfig of status.targets) {
    io.log(`${targetConfig.complete ? "✓" : "!"} ${targetConfig.label}: ${targetConfig.present}/${targetConfig.total}`);
  }
}

async function commandDoctor(catalogRoot, io = console) {
  const skillsRoot = path.join(catalogRoot, "skills");
  const sourceConfig = await loadSources(catalogRoot);
  const catalog = await buildCatalog(sourceConfig, skillsRoot);
  const configuredSources = new Set(sourceConfig.sources.map((source) => source.id));
  const topLevelEntries = await readdir(skillsRoot, { withFileTypes: true });
  for (const entry of topLevelEntries.filter((item) => item.isDirectory())) {
    if (!configuredSources.has(entry.name)) {
      fail(`Unregistered source directory under skills/: ${entry.name}`);
    }
  }
  const packs = await loadPacks(catalogRoot);
  for (const pack of packs.values()) {
    resolvePack(catalog, sourceConfig, pack);
  }
  for (const source of sourceConfig.sources) {
    for (const skillName of Object.keys(source.skillPaths ?? {})) {
      const skill = catalog.byName.get(skillName);
      if (!skill || skill.source.id !== source.id) {
        fail(`Unused Skill path mapping: ${source.id} -> ${skillName}`);
      }
    }
  }
  io.log(
    `OK: ${catalog.byName.size} Skills, ${sourceConfig.sources.length} sources, ${packs.size} Packs`,
  );
}

async function commandUpdate(argumentsList, catalogRoot, io = console) {
  const checkOnly = argumentsList.includes("--check");
  const remainingArguments = argumentsList.filter((argument) => argument !== "--check");
  const unknownOption = remainingArguments.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    fail(`Unknown option: ${unknownOption}`);
  }
  if (remainingArguments.length > 1) {
    fail("Usage: update [source] [--check]");
  }
  const [target] = remainingArguments;
  const sourceConfig = await loadSources(catalogRoot);
  const catalog = await buildCatalog(sourceConfig, path.join(catalogRoot, "skills"));
  const sources = target
    ? sourceConfig.sources.filter((source) => source.id === target)
    : sourceConfig.sources;
  if (sources.length === 0) {
    fail(`Unknown source: ${target}`);
  }
  if (checkOnly) {
    for (const source of sources) {
      const latest = remoteHead(source);
      const status = latest === source.revision ? "up to date" : "update available";
      io.log(`${source.id}: ${status} ${source.revision.slice(0, 8)} -> ${latest.slice(0, 8)}`);
    }
    return;
  }

  const tempDirectory = await createTempDirectory(catalogRoot);
  const stageDirectory = path.join(tempDirectory, "stage");
  const revisions = new Map();
  try {
    for (const source of sources) {
      io.log(`\nFetching upstream: ${source.name}`);
      const cloneDirectory = path.join(tempDirectory, "clone", source.id);
      const revision = await cloneHead(source, cloneDirectory);
      const group = catalog.groups.find((item) => item.source.id === source.id);
      await stageSource(
        source,
        cloneDirectory,
        stageDirectory,
        group.skills.map((skill) => skill.name),
      );
      revisions.set(source.id, revision);
    }

    const replacements = [];
    for (const source of sources) {
      const group = catalog.groups.find((item) => item.source.id === source.id);
      for (const skill of group.skills) {
        const relativePath = path.join("skills", source.id, skill.name);
        replacements.push({
          relativePath,
          staged: path.join(stageDirectory, source.id, skill.name),
          target: path.join(catalogRoot, relativePath),
        });
      }
      if (source.licenseFile) {
        replacements.push({
          relativePath: source.licenseFile,
          staged: path.join(stageDirectory, source.licenseFile),
          target: path.join(catalogRoot, source.licenseFile),
        });
      }
    }
    await replaceStagedFiles(replacements, tempDirectory);
    for (const source of sources) {
      const previous = source.revision;
      source.revision = revisions.get(source.id);
      io.log(`${source.id}: ${previous.slice(0, 8)} -> ${source.revision.slice(0, 8)}`);
    }
    await saveSources(catalogRoot, sourceConfig);
    io.log("\nUpdate complete. Run doctor, review git diff, test, then commit.\n");
  } finally {
    await removeTempDirectory(tempDirectory);
  }
}

async function commandAdd(argumentsList, catalogRoot, io = console) {
  const skillsRoot = path.join(catalogRoot, "skills");
  const packsRoot = path.join(catalogRoot, "packs");
  const sourcesFile = path.join(catalogRoot, "sources.lock.json");
  const packsValue = takeOption(argumentsList, "--pack");
  const packIds = packsValue
    ? packsValue.split(",").map((value) => value.trim()).filter(Boolean)
    : ["common"];
  const [sourceReference, ...requestedSkillNames] = argumentsList;
  const discoverAll = requestedSkillNames.length === 0;
  if (!sourceReference) {
    fail("Usage: skill-add <source-id|owner/repo> [skill...] [--pack <pack,pack>]");
  }
  const unknownOption = argumentsList.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    fail(`Unknown option: ${unknownOption}`);
  }
  requestedSkillNames.forEach(assertSafeSkillName);
  const packs = await loadPacks(catalogRoot);
  for (const packId of packIds) {
    if (!packs.has(packId)) {
      fail(`Unknown Pack: ${packId}`);
    }
  }

  // A fresh catalog starts with zero registered sources; loadSources rejects
  // that, so the first source registers against an empty config instead.
  const lockData = await readJson(sourcesFile);
  const sourceConfig =
    Array.isArray(lockData.sources) && lockData.sources.length > 0
      ? await loadSources(catalogRoot)
      : { schemaVersion: lockData.schemaVersion ?? 1, sources: [] };
  const sourcesFileBefore = await readFile(sourcesFile, "utf8");
  const packFilesBefore = new Map(
    await Promise.all(
      packIds.map(async (packId) => [packId, await readFile(path.join(packsRoot, `${packId}.json`), "utf8")]),
    ),
  );
  let source = findSource(sourceConfig, sourceReference);
  let registeredSource = false;
  if (!source) {
    // owner/repo, URLs, and SSH refs always contain "/"; local paths may use
    // the platform separator instead (Windows: "\").
    if (!sourceReference.includes("/") && !sourceReference.includes("\\")) {
      fail(`Unknown source: ${sourceReference}`);
    }
    source = await registerSource(catalogRoot, sourceConfig, {
      id: deriveSourceId(sourceReference),
      name: sourceReference.replace(/\.git$/i, ""),
      repository: sourceReference,
    }, io);
    registeredSource = true;
  }
  const sourceId = source.id;
  let skillNames = requestedSkillNames;
  let mappingsChanged = false;
  let tempDirectory;
  let cloneDirectory;
  const stagedSkillPaths = new Map();
  const catalogBeforeInstall = await buildCatalog(sourceConfig, skillsRoot);
  const sourceGroup = catalogBeforeInstall.groups.find((group) => group.source.id === sourceId);
  const knownSkillNames = sourceGroup?.skills.map((skill) => skill.name) ?? [];
  const duplicateSkillNames = discoverAll ? knownSkillNames : requestedSkillNames;
  if (
    duplicateSkillNames.length > 0 &&
    duplicateSkillNames.every(
      (skillName) =>
        catalogBeforeInstall.byName.get(skillName)?.source.id === sourceId &&
        skillCoveredByPacks(packs, packIds, sourceId, skillName),
    )
  ) {
    io.log(
      `Already installed: ${sourceId} (${duplicateSkillNames.length} Skill${duplicateSkillNames.length === 1 ? "" : "s"})`,
    );
    io.log(`Packs: ${packIds.join(", ")}`);
    return;
  }
  try {
    if (discoverAll) {
      tempDirectory = await createTempDirectory(catalogRoot);
      cloneDirectory = path.join(tempDirectory, "clone", source.id);
      io.log(`Fetching locked source: ${source.name} @ ${source.revision.slice(0, 8)}`);
      await cloneRevision(source, cloneDirectory);
      const discovered = await discoverSourceSkills(source, cloneDirectory);
      skillNames = discovered.names;
      mappingsChanged = discovered.mappingsChanged;
      io.log(`Discovered ${skillNames.length} Skill${skillNames.length === 1 ? "" : "s"}`);
    }

    const catalog = await buildCatalog(sourceConfig, skillsRoot);
    const newSkillNames = [];
    for (const skillName of skillNames) {
      const existing = catalog.byName.get(skillName);
      if (existing && existing.source.id !== sourceId) {
        fail(`Skill ${skillName} already belongs to source ${existing.source.id}`);
      }
      if (!existing) {
        newSkillNames.push(skillName);
      }
    }

    if (newSkillNames.length > 0 && !discoverAll) {
      tempDirectory ??= await createTempDirectory(catalogRoot);
      cloneDirectory ??= path.join(tempDirectory, "clone", source.id);
      if (!existsSync(cloneDirectory)) {
        io.log(`Fetching locked source: ${source.name} @ ${source.revision.slice(0, 8)}`);
        await cloneRevision(source, cloneDirectory);
      }
      const discovered = await discoverSourceSkills(source, cloneDirectory);
      mappingsChanged ||= discovered.mappingsChanged;
      for (const skillName of newSkillNames) {
        if (!discovered.names.includes(skillName)) {
          fail(`Skill not found upstream: ${skillName}`);
        }
      }
    }

    if (newSkillNames.length > 0) {
      tempDirectory ??= await createTempDirectory(catalogRoot);
      cloneDirectory ??= path.join(tempDirectory, "clone", source.id);
      const stageDirectory = path.join(tempDirectory, "stage");
      if (!existsSync(cloneDirectory)) {
        io.log(`Fetching locked source: ${source.name} @ ${source.revision.slice(0, 8)}`);
        await cloneRevision(source, cloneDirectory);
      }
      await stageSource(source, cloneDirectory, stageDirectory, newSkillNames);
      const replacements = newSkillNames.map((skillName) => ({
        relativePath: path.join("skills", source.id, skillName),
        staged: path.join(stageDirectory, source.id, skillName),
        target: path.join(skillsRoot, source.id, skillName),
      }));
      for (const replacement of replacements) {
        stagedSkillPaths.set(replacement.target, existsSync(replacement.target));
      }
      await replaceStagedFiles(replacements, tempDirectory);
    }

    const packChanges = await addSkillsToPacks(catalogRoot, packIds, sourceId, skillNames);
    if (mappingsChanged) {
      await saveSources(catalogRoot, sourceConfig);
    }

    if (packChanges.added.length > 0) {
      io.log(
        discoverAll && skillNames.length > 1
          ? `Added all Skills: ${sourceId} (${skillNames.length})`
          : `Added: ${sourceId} -> ${skillNames.join(", ")}`,
      );
    } else {
      io.log("No Pack changes");
    }
    if (packChanges.inherited.length > 0) {
      io.log(`Inherited from common: ${packChanges.inherited.join(", ")}`);
    }
  } catch (error) {
    try {
      await writeFile(sourcesFile, sourcesFileBefore, "utf8");
      for (const [packId, contents] of packFilesBefore) {
        await writeFile(path.join(packsRoot, `${packId}.json`), contents, "utf8");
      }
      for (const [skillPath, existed] of stagedSkillPaths) {
        if (!existed) {
          await rm(skillPath, { recursive: true, force: true });
        }
      }
      if (registeredSource) {
        if (source.licenseFile) {
          await rm(path.join(catalogRoot, source.licenseFile), { force: true });
        }
        await rm(path.join(skillsRoot, source.id), { recursive: true, force: true });
      }
    } catch (rollbackError) {
      fail(`Add failed and rollback failed: ${rollbackError.message}`);
    }
    throw error;
  } finally {
    if (tempDirectory) {
      await removeTempDirectory(tempDirectory);
    }
  }
  io.log(`Packs: ${packIds.join(", ")}`);
}

async function commandRemove(argumentsList, catalogRoot, io = console) {
  const packsRoot = path.join(catalogRoot, "packs");
  const packsValue = takeOption(argumentsList, "--pack");
  const [sourceReference, ...requestedSkillNames] = argumentsList;
  if (!sourceReference || requestedSkillNames.length === 0) {
    fail("Usage: remove <source-id|owner/repo> <skill...> [--pack <pack,pack>]");
  }
  const unknownOption = argumentsList.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    fail(`Unknown option: ${unknownOption}`);
  }
  const skillNames = [...new Set(requestedSkillNames)];
  skillNames.forEach(assertSafeSkillName);
  const sourceConfig = await loadSources(catalogRoot);
  const source = findSource(sourceConfig, sourceReference);
  if (!source) {
    io.log(`Already absent: ${sourceReference} -> ${skillNames.join(", ")}`);
    return;
  }
  const packs = await loadPacks(catalogRoot);
  const packIds = packsValue
    ? packsValue.split(",").map((value) => value.trim()).filter(Boolean)
    : [...packs.keys()];
  for (const packId of packIds) {
    assertSafeId(packId, "Pack id");
    if (!packs.has(packId)) {
      fail(`Unknown Pack: ${packId}`);
    }
  }

  const removedMemberships = [];
  for (const packId of packIds) {
    const pack = packs.get(packId);
    let changed = false;
    for (const selection of pack.sources.filter((item) => item.source === source.id)) {
      const present = skillNames.filter((skillName) => selection.skills.includes(skillName));
      const before = selection.skills.length;
      selection.skills = selection.skills.filter((skillName) => !skillNames.includes(skillName));
      for (const skillName of present) {
        removedMemberships.push({ packId, skillName });
      }
      changed ||= selection.skills.length !== before;
    }
    pack.sources = pack.sources.filter((selection) => selection.skills.length > 0);
    if (changed) {
      await writeJson(path.join(packsRoot, `${packId}.json`), pack);
    }
  }

  const candidates = skillNames.map((skillName) => ({ sourceId: source.id, skillName }));
  const pruned = await pruneCatalogSkills(catalogRoot, sourceConfig, packs, candidates);
  if (removedMemberships.length === 0 && pruned.removed.length === 0) {
    io.log(`Already absent: ${source.id} -> ${skillNames.join(", ")}`);
    return;
  }
  io.log(`Removed from Packs: ${removedMemberships.length}`);
  io.log(`Removed vendored Skills: ${pruned.removed.map((item) => item.skillName).join(", ") || "None"}`);
  if (pruned.removedSources.length > 0) {
    io.log(`Removed empty sources: ${pruned.removedSources.join(", ")}`);
  }
}

async function commandPackRemove(argumentsList, catalogRoot, io = console) {
  const packsRoot = path.join(catalogRoot, "packs");
  if (argumentsList.length === 0) {
    fail("Usage: pack-remove <pack...>");
  }
  const packIds = [...new Set(parsePackArguments(argumentsList))];
  packIds.forEach((packId) => assertSafeId(packId, "Pack id"));
  if (packIds.includes("common")) {
    fail("The common Pack cannot be removed");
  }
  const sourceConfig = await loadSources(catalogRoot);
  const packs = await loadPacks(catalogRoot);
  const existing = packIds.filter((packId) => packs.has(packId));
  const absent = packIds.filter((packId) => !packs.has(packId));
  if (absent.length > 0) {
    io.log(`Already absent: ${absent.join(", ")}`);
  }
  if (existing.length === 0) {
    io.log("No Pack changes");
    return;
  }

  const candidates = [];
  for (const packId of existing) {
    const pack = packs.get(packId);
    for (const selection of pack.sources) {
      for (const skillName of selection.skills) {
        candidates.push({ sourceId: selection.source, skillName });
      }
    }
    packs.delete(packId);
  }
  for (const packId of existing) {
    await rm(path.join(packsRoot, `${packId}.json`));
  }
  const pruned = await pruneCatalogSkills(catalogRoot, sourceConfig, packs, candidates);
  io.log(`Removed Packs: ${existing.join(", ")}`);
  io.log(`Removed orphan Skills: ${pruned.removed.length}`);
  if (pruned.removedSources.length > 0) {
    io.log(`Removed empty sources: ${pruned.removedSources.join(", ")}`);
  }
}

async function commandSourceAdd(argumentsList, catalogRoot, io = console) {
  const name = takeOption(argumentsList, "--name");
  const skillRoot = takeOption(argumentsList, "--skill-root");
  const licenseSource = takeOption(argumentsList, "--license");
  const [id, repository] = argumentsList;
  if (!id || !repository || argumentsList.length !== 2) {
    fail("Usage: source-add <id> <repository> [--name <name>] [--skill-root <path>] [--license <path>]");
  }
  const sourceConfig = await loadSources(catalogRoot);
  await registerSource(catalogRoot, sourceConfig, {
    id,
    licenseSource,
    name,
    repository,
    skillRoot,
  }, io);
  io.log(`Next: avenic catalog skill-add ${id} <skill-name> --pack <pack>`);
}

async function commandPackAdd(argumentsList, catalogRoot, io = console) {
  const packsRoot = path.join(catalogRoot, "packs");
  const name = takeOption(argumentsList, "--name");
  const description = takeOption(argumentsList, "--description");
  const [id] = argumentsList;
  if (!id || argumentsList.length !== 1) {
    fail("Usage: pack-add <id> [--name <name>] [--description <text>]");
  }
  assertSafeId(id, "Pack id");
  const packFile = path.join(packsRoot, `${id}.json`);
  if (!isInside(packsRoot, packFile) || existsSync(packFile)) {
    fail(`Pack already exists: ${id}`);
  }
  const displayName =
    name ??
    id
      .split(/[-_.]+/)
      .filter(Boolean)
      .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
      .join(" ");
  await writeJson(packFile, {
    schemaVersion: 1,
    id,
    name: displayName,
    description: description ?? `Custom ${displayName} workflows.`,
    sources: [],
  });
  io.log(`Created Pack: ${id}`);
  io.log(`File: ${packFile}`);
  io.log(`Next: avenic catalog skill-add <source> <skill-name> --pack ${id}`);
}

async function runMaintenanceCommand(command, argumentsList, catalogRoot, io) {
  switch (command) {
    case "doctor":
      await commandDoctor(catalogRoot, io);
      break;
    case "update":
      await commandUpdate(argumentsList, catalogRoot, io);
      break;
    case "skill-add":
      await commandAdd([...argumentsList], catalogRoot, io);
      break;
    case "remove":
      await commandRemove([...argumentsList], catalogRoot, io);
      break;
    case "pack-add":
      await commandPackAdd([...argumentsList], catalogRoot, io);
      break;
    case "pack-remove":
      await commandPackRemove([...argumentsList], catalogRoot, io);
      break;
    case "source-add":
      await commandSourceAdd([...argumentsList], catalogRoot, io);
      break;
    default:
      fail(`Unknown command: ${command}`);
  }
}

async function commandCatalogSync(options = {}) {
  const io = options.io ?? console;
  const spec = await loadDefaultCatalogSpec(options.environment);
  const catalogInfo = await ensureCatalog(spec, {
    environment: options.environment,
    io,
  });
  io.log("Catalog sync\n");
  io.log(`Catalog   ${catalogInfo.spec}`);
  io.log(`Cache     ${catalogInfo.catalogRoot}`);
  io.log(`Revision  ${catalogInfo.revision}`);
}

async function commandCatalogAdd(argumentsList, options = {}) {
  const io = options.io ?? console;
  const [spec] = argumentsList;
  if (!spec || argumentsList.length !== 1) {
    fail("Usage: avenic catalog add <spec>");
  }
  const result = await registerCatalog(spec, { environment: options.environment, io });
  io.log(`Default catalog: ${spec}`);
  if (result.previewFailed) {
    io.log("\nSpec saved. Catalog preview unavailable:");
    io.log(`  ${String(result.error.message).split("\n")[0]}`);
  } else {
    io.log(`\nPacks · ${result.packs.length}`);
    result.packs.forEach((pack, packIndex) => {
      const lastPack = packIndex === result.packs.length - 1;
      const label = pack.name && pack.name !== pack.id ? `${pack.id} (${pack.name})` : pack.id;
      const purpose = pack.description ? ` — ${pack.description}` : "";
      io.log(`${lastPack ? "└──" : "├──"} ${label}${purpose}`);
    });
    io.log("\nInstall: avenic skills install [pack...]");
  }
  io.log("Run: avenic catalog sync");
}

// Seed the registry with the current spec on first use, so upgrading users
// see their catalog in `catalog list`/`catalog select` immediately.
async function ensureKnownCatalogs(options = {}) {
  let known = await loadKnownCatalogs(options.environment);
  if (known.length === 0) {
    const current = await loadDefaultCatalogSpec(options.environment);
    await registerKnownCatalog(options.environment, current);
    known = await loadKnownCatalogs(options.environment);
  }
  return known;
}

async function commandCatalogList(options = {}) {
  const io = options.io ?? console;
  const current = await loadDefaultCatalogSpec(options.environment);
  const known = await ensureKnownCatalogs(options);
  io.log("\nRegistered catalogs\n");
  for (const entry of known) {
    const marker = entry.spec === current ? ">" : " ";
    io.log(`${marker} ${entry.name}${entry.spec !== entry.name ? `   ${entry.spec}` : ""}`);
  }
  io.log("\n> = current. Switch: avenic catalog select");
}

// Arrow-key picker over the registered catalogs. Resolves to the chosen spec,
// or null when cancelled. Repaints the whole frame on every keypress with
// saved-cursor positioning: some terminals mishandle relative moveCursor
// repaints (frames pile up instead of replacing each other), so each paint
// restores the cursor saved at picker start, clears to the bottom of the
// screen, and rewrites the full frame. Runs in raw mode; callers must ensure
// the process owns a TTY.
function promptCatalogChoice(entries, currentIndex) {
  const output = process.stdout;
  const input = process.stdin;
  const count = entries.length;
  let selected = currentIndex >= 0 ? currentIndex : 0;
  return new Promise((resolve) => {
    const paint = () => {
      const width = Math.max(
        "Select a catalog:".length,
        "↑/↓ select · Enter confirm · Esc cancel".length,
        ...entries.map((entry) => entry.name.length),
      );
      const lines = ["Select a catalog:"];
      for (let index = 0; index < count; index += 1) {
        lines.push(`${index === selected ? ">" : " "} ${entries[index].name}`);
      }
      lines.push("↑/↓ select · Enter confirm · Esc cancel");
      output.write("\x1b[u"); // restore the cursor saved at picker start
      readline.clearScreenDown(output);
      output.write(lines.map((line) => line.padEnd(width)).join("\n"));
    };
    const finish = (result) => {
      input.setRawMode(false);
      input.pause();
      input.removeAllListeners("keypress");
      output.write("\n"); // keep the last frame visible; resume on a fresh line
      resolve(result);
    };
    input.on("keypress", (value, key) => {
      if (key.name === "up") {
        selected = (selected - 1 + count) % count;
        paint();
      } else if (key.name === "down") {
        selected = (selected + 1) % count;
        paint();
      } else if (key.name === "return" || key.name === "enter") {
        finish(entries[selected].spec);
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(null);
      }
    });
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[s"); // remember where the frame starts
    paint();
  });
}

async function commandCatalogSelect(argumentsList, options = {}) {
  const io = options.io ?? console;
  const [target] = argumentsList;
  if (argumentsList.length > 1) {
    fail("Usage: avenic catalog select [name|spec]");
  }
  const current = await loadDefaultCatalogSpec(options.environment);
  const known = await ensureKnownCatalogs(options);
  if (target) {
    const entry = known.find((candidate) => candidate.spec === target)
      ?? known.find((candidate) => candidate.name === target);
    if (!entry) {
      fail(`Unknown catalog: ${target}\nAdd one first: avenic catalog add <spec>`);
    }
    await setDefaultCatalogSpec(options.environment, entry.spec);
    io.log(`Current catalog: ${entry.spec}`);
    return;
  }
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    // No terminal (pipes, scripts): print the plain list instead.
    await commandCatalogList(options);
    return;
  }
  const currentIndex = known.findIndex((entry) => entry.spec === current);
  // The picker paints its own title as the first frame line.
  const chosen = await promptCatalogChoice(known, currentIndex);
  if (chosen === null) {
    io.log("No change.");
    return;
  }
  await setDefaultCatalogSpec(options.environment, chosen);
  io.log(`Current catalog: ${chosen}`);
}

async function commandCatalogDefault(options = {}) {
  const io = options.io ?? console;
  io.log(`Default catalog: ${await loadDefaultCatalogSpec(options.environment)}`);
}

export async function dispatchCatalog(argumentsList, options = {}) {
  const io = options.io ?? console;
  const scope = parseScopeArguments(argumentsList);
  // The entry point (dispatchSkills) strips scope flags before delegating here,
  // so the global flag must survive the delegation to keep validation intact.
  const global = scope.global || options.global;
  const [command, ...remainingArguments] = scope.argumentsList;
  if (command === "sync") {
    if (global || remainingArguments.length > 0) {
      fail("Usage: avenic catalog sync");
    }
    await commandCatalogSync(options);
    return;
  }
  if (command === "add") {
    if (global) {
      fail("avenic catalog add does not accept a global scope");
    }
    await commandCatalogAdd(remainingArguments, options);
    return;
  }
  if (command === "default") {
    if (global || remainingArguments.length > 0) {
      fail("Usage: avenic catalog default");
    }
    await commandCatalogDefault(options);
    return;
  }
  if (command === "select") {
    if (global) {
      fail("avenic catalog select does not accept a global scope");
    }
    await commandCatalogSelect(remainingArguments, options);
    return;
  }
  if (command === "list") {
    if (global || remainingArguments.length > 0) {
      fail("Usage: avenic catalog list");
    }
    await commandCatalogList(options);
    return;
  }
  const maintenanceCommands = new Set([
    "doctor",
    "update",
    "skill-add",
    "remove",
    "pack-add",
    "pack-remove",
    "source-add",
  ]);
  if (!command || !maintenanceCommands.has(command)) {
    fail("Usage: avenic catalog <sync|add|select|list|default|doctor|update|skill-add|remove|pack-add|pack-remove|source-add>");
  }
  if (global) {
    fail(`${command} does not accept a global scope`);
  }
  const cwd = options.cwd ?? process.cwd();
  if (!isCatalogDirectory(cwd)) {
    fail(`${command} must run inside the Avenic Git clone`);
  }
  return runMaintenanceCommand(command, remainingArguments, cwd, io);
}

export async function dispatchSkills(argumentsList, options = {}) {
  const io = options.io ?? console;
  const scope = parseScopeArguments(argumentsList);
  const [firstArgument, ...remainingArguments] = scope.argumentsList;
  const command = firstArgument ?? "install";
  const commandOptions = { ...options, global: scope.global || options.global };
  if (command === "add") {
    await commandAddDirect(remainingArguments, commandOptions);
    return;
  }
  // "remove" pairs with "add": it removes externally installed Skills, and
  // precedes the catalog maintenance set below for the same reason "add" does.
  if (command === "remove") {
    await commandUninstallSkill(remainingArguments, commandOptions);
    return;
  }
  if (command === "install") {
    await commandInstall(remainingArguments, commandOptions);
    return;
  }
  if (command === "skills") {
    await dispatchSkills(remainingArguments, { ...options, global: scope.global || options.global });
    return;
  }
  if (command === "catalog") {
    await dispatchCatalog(remainingArguments, {
      io,
      cwd: options.cwd ?? process.cwd(),
      environment: options.environment ?? process.env,
      global: scope.global || options.global,
    });
    return;
  }
  const maintenanceCommands = new Set([
    "doctor",
    "update",
    "skill-add",
    "remove",
    "pack-add",
    "pack-remove",
    "source-add",
  ]);
  if (maintenanceCommands.has(command)) {
    if (scope.global) {
      fail(`${command} does not accept a global scope`);
    }
    const cwd = options.cwd ?? process.cwd();
    if (!isCatalogDirectory(cwd)) {
      // Outside a catalog clone, doctor and update fall back to their runtime
      // meanings (environment check and CLI self-update); the other maintenance
      // commands only make sense inside the catalog Git clone.
      if (command === "doctor" || command === "update") {
        const { runCli } = await import("./dispatcher.mjs");
        return runCli({ argumentsList: [command, ...remainingArguments] });
      }
      fail(`${command} must run inside the Avenic Git clone`);
    }
    return runMaintenanceCommand(command, remainingArguments, cwd, io);
  }

  if (command === "help" || command === "--help" || command === "-h") {
    const { printHelp } = await import("./dispatcher.mjs");
    printHelp(io);
    return;
  }
  if (command === "self-update") {
    if (scope.global || remainingArguments.length > 0) {
      fail("Usage: self-update");
    }
    await updateAvenic(packageRoot);
    return;
  }
  if (command === "uninstall" && remainingArguments.length === 0) {
    await commandUninstall([], commandOptions);
    return;
  }

  // Known subcommands resolve the catalog themselves; handle them before any
  // network work so typos in the command position never trigger a fetch.
  switch (command) {
    case "packs":
      await commandPacks(commandOptions);
      return;
    case "tree":
      await commandTree(remainingArguments, commandOptions);
      return;
    case "uninstall":
      await commandUninstall(remainingArguments, commandOptions);
      return;
    case "status":
      await commandStatus(commandOptions);
      return;
  }

  // Agent runtime commands (claude/codex/opencode lifecycle, sessions) are
  // handled by the runtime dispatcher; delegate before the Pack fallback so
  // typos in the agent position never trigger a network fetch. The bare
  // `avenic status` overview stays reachable through the main entry.
  if (Object.hasOwn(AGENTS, command) || command === "sessions") {
    const { runCli } = await import("./dispatcher.mjs");
    return runCli({ argumentsList: scope.argumentsList });
  }

  // Anything else is a Pack id (ids are user-defined, so the catalog is the
  // only source of truth for telling Packs from typos).
  const catalogInfo = await resolveInstallSource(commandOptions);
  const packs = await loadPacks(catalogInfo.catalogRoot);
  if (packs.has(command)) {
    await commandInstall([command, ...remainingArguments], commandOptions);
    return;
  }
  fail(`Unknown command or Pack: ${command}`);
}
