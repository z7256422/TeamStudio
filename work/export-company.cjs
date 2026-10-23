/* 导出与页面同源的公司模板及完整岗位指令，使用稳定 ID 便于人工审阅差异。 */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ crypto: require('node:crypto') });
for (const file of ['constants.js', 'capabilities.js', 'team-presets.js', 'company-roles.js', 'company-template.js', 'model.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'panel-src/config', file), 'utf8'), context, { filename: file });
}
const config = context.makeProductCompany(), departments = vm.runInContext('COMPANY_DEPARTMENTS', context);
const teamIds = new Map(), memberIds = new Map();
config.teams.forEach((entry, index) => {
  const spec = departments[index]; teamIds.set(entry.id, 'company-' + spec.key);
  entry.agents.forEach((agent, i) => memberIds.set(agent.id, spec.key + '-' + spec.members[i].key));
});
for (const entry of config.teams) {
  entry.id = teamIds.get(entry.id); entry.team.leaderId = memberIds.get(entry.team.leaderId);
  entry.team.children = entry.team.children.map(id => teamIds.get(id));
  entry.agents.forEach(agent => { agent.id = memberIds.get(agent.id); });
}
config.activeTeamId = teamIds.get(config.activeTeamId);
fs.writeFileSync(path.join(root, 'outputs/product-company.json'), JSON.stringify(context.validateConfig(config), null, 2) + '\n');
const document = '# 28 人产品研发公司：岗位职责与完整提示词\n\n从页面同源模板生成。7 个团队，各有一名直属负责人；研发管理团队包含其余 6 个部门。修改岗位模板后运行 `node work/export-company.cjs` 同步本文件和可导入配置。\n\n'
  + config.teams.map(entry => `## ${entry.team.name}（${entry.agents.length} 人）\n\n` + entry.agents.map(agent => `### ${agent.name} · ${agent.role}\n\n${agent.prompt}\n`).join('\n')).join('\n');
fs.writeFileSync(path.join(root, 'outputs/product-company-prompts.md'), document);
console.log('Exported 7 teams / 28 members with full prompts.');
