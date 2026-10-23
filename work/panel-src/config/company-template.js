/* 岗位文本与组织实例分离：新建组织生成独立 ID，导入/保存仍使用兼容的 version 2。 */
const COMPANY_WORK_RULES = `共同执行约定
1. 使用简体中文；先阅读本轮目标、项目规范和已有产物，保留他人改动。输入不足时区分事实、假设和阻塞。
2. 普通问答直接回复即可；仅做与本轮授权范围相关的工作，不为模板额外创建文档、修改文件或派发全员。
3. 软件、CAD、EDA、仿真、仪器等仅使用实际可用且获准的工具。没有工具/设备时明确缺口、可交付内容与未验证项，不能伪造文件、运行、测量、访谈或认证。
4. 工作包至少说明目标、需求编号/依据、输入版本、责任范围、输出位置、接口、依赖及验收条件。共享文件有冲突时串行；不覆盖其他部门目录。复杂产品沿用项目文档，无现有结构时可用 docs/product/ 记录需求、接口、决策、风险和交付索引。
5. 只有本轮注册了管理工具的负责人才能派发：用 team_dispatch 指定直属成员或直接子团队负责人，用 team_wait 挂起等待，用 team_reply_member 处理成员问题；按实际证据验收，必要时再次派发同一成员返工。禁止绕过部门层级和使用引擎子代理替代配置成员。
6. 被派发时通过 team_ask_manager 向直接上级反馈关键问题，包含事实、影响、已尝试方案和建议；负责人可将跨部门问题逐级升级，再把决定回复原提问者。等待由事件唤醒，不写轮询；普通进度不当成提问。
7. 同一组织中成员各自保留 Provider/模型配置。成员与负责人均不能代替用户授权采购、外发资料、发布、生产或不可逆操作。
8. 完成时交接：完成内容、实际文件/版本、验证方法与证据、未完成/未验证项、风险和下游动作。明确区分方案、仿真、样机、实机和量产状态；不以计划或口头声明替代实际成果。`;

function companyRolePrompt(department, member) {
  return `你是「${department.name}」的${member.name}。\n团队使命：${department.mission}\n岗位责任：${member.responsibility}\n\n接单输入\n${member.inputs}\n\n职责\n${member.duties.map((duty, i) => `${i + 1}. ${duty}`).join('\n')}\n\n职责边界\n${member.boundaries}\n\n交付与验收\n${member.outputs}\n所有结论必须对应实际产物与证据；不适用的交付项说明原因，不为凑齐清单制造文件。\n\n协作与反馈\n${member.handoff}\n${member.role === 'ProjectManager' ? '独立启动本团队时，你是任务总负责人，直接响应用户；作为上级派发的子团队负责人时，只管理本团队子树，并向派发你的上级交接，不重复定义整个产品范围。' : '只执行本轮分工，不直接启动或指挥其他成员；依赖与跨部门变更交给派发你的负责人协调。'}\n\n${COMPANY_WORK_RULES}`;
}

function makeProductCompany(defaults = {}) {
  const teams = COMPANY_DEPARTMENTS.map(department => {
    const agents = department.members.map((member, index) => ({ ...makeAgent(index), name: member.name, role: member.role,
      description: member.responsibility, prompt: companyRolePrompt(department, member),
      provider: defaults.provider || 'codex-app-server', model: defaults.model || 'default' }));
    return { id: crypto.randomUUID(), team: { name: department.name, strategy: 'manager', concurrency: 1,
      provider: defaults.provider || 'codex-app-server', model: defaults.model || 'default', cwd: defaults.cwd || '',
      sandbox: defaults.sandbox || 'danger-full-access', approvalPolicy: defaults.approvalPolicy || 'on-request',
      leaderId: agents[0].id, children: [], ...defaultTeamCapabilities() }, agents };
  });
  teams[0].team.children = teams.slice(1).map(team => team.id);
  return { version: 2, activeTeamId: teams[0].id, providers: BUILTIN_PROVIDERS.map(provider => ({ ...provider })), teams };
}

// 旧配置不自动覆盖；用户主动添加模板后仍可撤销，保存时才落入当前浏览器。
function addProductCompany(config, defaults = {}) {
  if (config.teams.length + COMPANY_DEPARTMENTS.length > MAX_TEAMS) throw new Error(`添加组织需要 ${COMPANY_DEPARTMENTS.length} 个团队名额，最多 ${MAX_TEAMS} 个团队`);
  const company = makeProductCompany(defaults);
  return validateConfig({ ...config, activeTeamId: company.activeTeamId, teams: [...config.teams, ...company.teams] });
}
