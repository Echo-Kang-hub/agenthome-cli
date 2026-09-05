import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  addSkillsToPacks,
  assertSafeId,
  assertSafeSkillName,
  buildCatalog,
  cloneRevision,
  createInstallContext,
  createTempDirectory,
  deriveSourceId,
  discoverSourceSkills,
  fail,
  findSource,
  installCopies,
  installedPackIds,
  isCatalogDirectory,
  isInside,
  loadPacks,
  loadSources,
  parsePackArguments,
  previousManagedState,
  printTree,
  pruneCatalogSkills,
  readJson,
  registerSource,
  remoteHead,
  removeAllManagedSkills,
  removeEmptyDirectory,
  removeInstallationFiles,
  removeSkillDirectories,
  removeTempDirectory,
  replaceStagedFiles,
  resolveInstallPacks,
  resolvePack,
  resolvePacks,
  saveSources,
  skillCoveredByPacks,
  stageSource,
  stateRoot,
  writeInstallMetadata,
  writeJson,
} from "#core";
import { updateAgentHome } from "./self-update.mjs";

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

async function resolveCatalogSource(options) {
  const spec = options.environment?.AGENTHOME_CATALOG_SPEC;
  if (!spec) {
    fail("No catalog available: configure one with `agent catalog use <spec>` and run `agent catalog sync`");
  }
  const catalogRoot = path.resolve(options.cwd ?? process.cwd(), spec);
  const packageMetadata = existsSync(path.join(catalogRoot, "package.json"))
    ? await readJson(path.join(catalogRoot, "package.json"))
    : null;
  return { catalogRoot, spec: null, repository: null, revision: null, packageMetadata };
}

async function commandInstall(explicitPacks = [], options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  if (!options.global && isCatalogDirectory(options.cwd ?? process.cwd())) {
    fail("Run installation from a work project, not from the AgentHome catalog");
  }
  const catalogInfo = await resolveCatalogSource(options);
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, path.join(catalogInfo.catalogRoot, "skills"));
  const packs = await loadPacks(catalogInfo.catalogRoot);
  const packIds = await resolveInstallPacks(context, explicitPacks);
  const resolvedPacks = resolvePacks(catalog, sourceConfig, packs, packIds);
  const packNames = resolvedPacks.packs.map((pack) => pack.name).join(" + ");
  printTree(resolvedPacks.groups, "Skill Installation Plan", [
    `Packs: ${packNames}`,
    `Scope: ${context.label}`,
    `Root: ${context.root}`,
    `Duplicate selections removed: ${resolvedPacks.duplicateSelections}`,
  ], io);
  await installCopies(context, resolvedPacks, io);
  await writeInstallMetadata(context, resolvedPacks, catalogInfo);
  io.log(`\nInstallation complete: ${resolvedPacks.names.length} unique Skills`);
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
    const total = await removeAllManagedSkills(context, managed, io);
    await removeInstallationFiles(context);
    if (options.global) {
      await removeEmptyDirectory(stateRoot(options.environment));
    }
    io.log(`Uninstalled all managed ${context.label.toLowerCase()} Skills: ${total}`);
    return;
  }

  const requested = parsePackArguments(packArguments);
  requested.forEach((packId) => assertSafeId(packId, "Pack id"));

  const removable = new Set(requested.filter((packId) => packId !== "common"));
  const removed = current.filter((packId) => removable.has(packId));
  const absent = requested.filter((packId) => packId !== "common" && !current.includes(packId));
  if (requested.includes("common")) {
    io.log("Skipped: common is always included");
  }
  if (absent.length > 0) {
    io.log(`Already absent: ${absent.join(", ")}`);
  }
  if (removed.length === 0) {
    io.log("No Pack changes");
    return;
  }

  const catalogInfo = await resolveCatalogSource(options);
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, path.join(catalogInfo.catalogRoot, "skills"));
  const packs = await loadPacks(catalogInfo.catalogRoot);
  const remaining = current.filter((packId) => !removable.has(packId));
  const resolvedPacks = resolvePacks(catalog, sourceConfig, packs, remaining);
  printTree(resolvedPacks.groups, "Skill Uninstall Plan", [
    `Remove Packs: ${removed.join(" + ")}`,
    `Keep Packs: ${resolvedPacks.packs.map((pack) => pack.name).join(" + ")}`,
    `Scope: ${context.label}`,
    `Root: ${context.root}`,
  ], io);
  await installCopies(context, resolvedPacks, io);
  await writeInstallMetadata(context, resolvedPacks, catalogInfo);
  io.log(`\nUninstall complete: ${removed.join(", ")}`);
}

async function commandUninstallSkill(skillArguments, options = {}) {
  const io = options.io ?? console;
  if (skillArguments.length === 0) {
    fail("Usage: uninstall-skill <skill...> [-g]");
  }
  const skillNames = [...new Set(skillArguments)];
  skillNames.forEach(assertSafeSkillName);
  const context = createInstallContext(options.global ?? false, options);
  const managed = await previousManagedState(context);
  const managedNames = skillNames.filter((skillName) => managed.has(skillName));
  if (managedNames.length > 0) {
    fail(
      `Managed by configured Packs: ${managedNames.join(", ")}. Uninstall the Pack or remove the Skill from the Catalog`,
    );
  }

  const total = await removeSkillDirectories(context, skillNames, io);
  io.log(total > 0 ? `Removed external Skills: ${skillNames.join(", ")}` : `Already absent: ${skillNames.join(", ")}`);
}

async function commandTree(packArguments, options = {}) {
  const io = options.io ?? console;
  const catalogInfo = await resolveCatalogSource(options);
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
  const catalogInfo = await resolveCatalogSource(options);
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
  if (!existsSync(context.lockFile)) {
    fail(`${context.label} scope has no lock file; install a Pack first`);
  }
  const manifest = await readJson(context.lockFile);
  const groups = (manifest.sources ?? []).map((source) => ({
    source,
    skills: (source.skills ?? []).map((name) => ({ name })),
  }));
  const manifestPacks = manifest.packs ?? (manifest.pack ? [manifest.pack] : []);
  printTree(groups, `Current ${context.label} Skills`, [
    `Packs: ${manifestPacks.map((pack) => pack.name ?? pack.id ?? pack).join(" + ")}`,
  ], io);
  const names = groups.flatMap((group) => group.skills.map((skill) => skill.name));
  for (const targetConfig of context.targets) {
    const directory = targetConfig.destination;
    const present = names.filter((name) => existsSync(path.join(directory, name, "SKILL.md"))).length;
    io.log(`${present === names.length ? "✓" : "!"} ${targetConfig.label}: ${present}/${names.length}`);
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
    fail("Usage: add <source-id|owner/repo> [skill...] [--pack <pack,pack>]");
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

  const sourceConfig = await loadSources(catalogRoot);
  const sourcesFileBefore = await readFile(sourcesFile, "utf8");
  const packFilesBefore = new Map(
    await Promise.all(
      packIds.map(async (packId) => [packId, await readFile(path.join(packsRoot, `${packId}.json`), "utf8")]),
    ),
  );
  let source = findSource(sourceConfig, sourceReference);
  let registeredSource = false;
  if (!source) {
    if (!sourceReference.includes("/")) {
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
  io.log(`Next: agent catalog add ${id} <skill-name> --pack <pack>`);
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
  io.log(`Next: agent catalog add <source> <skill-name> --pack ${id}`);
}

function printHelp(io = console) {
  io.log(`AgentHome Skills

Install Skills:
  agenthome                           Install Common, or sync the configured Packs
  agenthome <pack...>                 Install one or more Packs; Common is always included
  agenthome uninstall                 Remove all managed Skills and installation metadata
  agenthome uninstall <pack...>       Remove Packs and unneeded managed Skills
  agenthome uninstall-skill <skill...> Remove external, unmanaged Skills
  agenthome -g [pack...]              Install or sync in the global user scope
  agenthome packs                     List available Packs
  agenthome tree [pack...]            Show source -> Skill tree
  agenthome status [-g]               Show the project or global installed tree

Scope options:
  -g, --global                        Use global user directories

Maintain this private catalog (run inside its Git clone):
  agent catalog doctor
  agent catalog update [source] [--check]
  agent catalog add <source|owner/repo> [skill...] [--pack <pack,pack>]
  agent catalog remove <source|owner/repo> <skill...> [--pack <pack,pack>]
  agent catalog pack-add <id> [--name <name>] [--description <text>]
  agent catalog pack-remove <pack...>
  agent catalog source-add <id> <repo> [--name <name>] [--skill-root <path>]

Update AgentHome:
  agenthome self-update
`);
}

async function runMaintenanceCommand(command, argumentsList, catalogRoot, io) {
  switch (command) {
    case "doctor":
      await commandDoctor(catalogRoot, io);
      break;
    case "update":
      await commandUpdate(argumentsList, catalogRoot, io);
      break;
    case "add":
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

export async function dispatchCatalog(argumentsList, options = {}) {
  const io = options.io ?? console;
  const scope = parseScopeArguments(argumentsList);
  const [command, ...remainingArguments] = scope.argumentsList;
  const maintenanceCommands = new Set([
    "doctor",
    "update",
    "add",
    "remove",
    "pack-add",
    "pack-remove",
    "source-add",
  ]);
  if (!command || !maintenanceCommands.has(command)) {
    fail("Usage: agent catalog <doctor|update|add|remove|pack-add|pack-remove|source-add>");
  }
  if (scope.global) {
    fail(`${command} does not accept a global scope`);
  }
  const cwd = options.cwd ?? process.cwd();
  if (!isCatalogDirectory(cwd)) {
    fail(`${command} must run inside the AgentHome Git clone`);
  }
  return runMaintenanceCommand(command, remainingArguments, cwd, io);
}

export async function dispatchSkills(argumentsList, options = {}) {
  const io = options.io ?? console;
  const scope = parseScopeArguments(argumentsList);
  const [firstArgument, ...remainingArguments] = scope.argumentsList;
  const command = firstArgument ?? "install";
  const commandOptions = { ...options, global: scope.global };
  const maintenanceCommands = new Set([
    "doctor",
    "update",
    "add",
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
      fail(`${command} must run inside the AgentHome Git clone`);
    }
    return runMaintenanceCommand(command, remainingArguments, cwd, io);
  }

  if (!firstArgument) {
    await commandInstall([], commandOptions);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp(io);
    return;
  }
  if (command === "self-update") {
    if (scope.global || remainingArguments.length > 0) {
      fail("Usage: self-update");
    }
    await updateAgentHome(packageRoot);
    return;
  }
  if (command === "status") {
    await commandStatus(commandOptions);
    return;
  }
  if (command === "uninstall-skill") {
    await commandUninstallSkill(remainingArguments, commandOptions);
    return;
  }
  if (command === "uninstall" && remainingArguments.length === 0) {
    await commandUninstall([], commandOptions);
    return;
  }

  const catalogInfo = await resolveCatalogSource(commandOptions);
  const packs = await loadPacks(catalogInfo.catalogRoot);
  if (packs.has(command)) {
    await commandInstall([command, ...remainingArguments], commandOptions);
    return;
  }
  switch (command) {
    case "packs":
      await commandPacks(commandOptions);
      break;
    case "tree":
      await commandTree(remainingArguments, commandOptions);
      break;
    case "uninstall":
      await commandUninstall(remainingArguments, commandOptions);
      break;
    default:
      fail(`Unknown command or Pack: ${command}`);
  }
}
