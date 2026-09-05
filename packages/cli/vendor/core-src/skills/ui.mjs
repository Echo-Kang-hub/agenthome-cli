export function printTree(groups, title, details = [], io = console) {
  const total = groups.reduce((count, group) => count + group.skills.length, 0);
  io.log(`\n${title}`);
  for (const detail of details) {
    io.log(`  ${detail}`);
  }
  io.log(`\nSkills · ${total} unique`);
  groups.forEach((group, groupIndex) => {
    const lastGroup = groupIndex === groups.length - 1;
    const groupBranch = lastGroup ? "└──" : "├──";
    const childPrefix = lastGroup ? "    " : "│   ";
    io.log(
      `${groupBranch} ${group.source.name} · ${group.skills.length}`,
    );
    io.log(`${childPrefix}├── Repository: ${group.source.repository}`);
    io.log(`${childPrefix}├── Revision: ${group.source.revision.slice(0, 12)}`);
    group.skills.forEach((skill, skillIndex) => {
      const skillBranch = skillIndex === group.skills.length - 1 ? "└──" : "├──";
      io.log(`${childPrefix}${skillBranch} ${skill.name}`);
    });
  });
  io.log();
}
