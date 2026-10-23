const path = require('node:path');
const fs = require('node:fs');
const { LIGHTWEIGHT_GUIDANCE } = require('./execution-guidance.cjs');
const { TERMINAL_RUN_STATES } = require('./run-metadata.cjs');
const { DEFAULT_SANDBOX, sandboxPolicy } = require('./execution-permissions.cjs');
const { memberCompletionError, reportFromFinalAnswer } = require('./delivery-contract.cjs');
const { createTeamFeedback } = require('./team-feedback.cjs');
const { createTeamResults, memberResult, TOOL_RESULT_BYTES } = require('./team-results.cjs');
const { parseHierarchy, dispatchableMembers, delegatedManagement } = require('./team-hierarchy.cjs');

// 调度只依赖统一的运行接口；供应商负责把这些工具映射到自己的调用协议。
const tool = (name, description, properties, required) => ({ type: 'function', name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const text = { type: 'string' };
const TEAM_TOOLS = [
  tool('team_dispatch', '派发一个明确的子任务给团队成员。返回真实 runId；达到并发上限时先 team_wait。返工可再次派发同一成员并恢复其上下文。',
    { agentId: text, instruction: text }, ['agentId', 'instruction']),
  tool('team_wait', '挂起等待成员结果、提问或审批变化，由事件唤醒。结果只附短预览；outputTruncated 时用 team_read_result 读取全文。hasMore 时带 nextCursor 立即读取剩余状态页，不是再次等待。feedbackRequests 的 truncated 问题先读取 details 全文再答复，不能重复等待跳过问题。', { cursor: text }, []),
  tool('team_read_result', '读取同任务直属成员已保存的成果，可重复读取，无需重新派工。默认 section=result，进展用 progress，问题全文用 feedback，错误全文用 error。hasMore 时用 nextCursor 继续，直到 false 才是完整正文；不要根据预览验收或要求成员重写缺失段落。',
    { runId: text, section: { type: 'string', enum: ['result', 'progress', 'feedback', 'error'] }, cursor: text,
      maxBytes: { type: 'integer', minimum: 1024, maximum: TOOL_RESULT_BYTES } }, ['runId']),
  tool('team_reply_member', '回复正在等待的成员问题。必须给出可执行的决定、约定或补充信息；回复后成员会沿用原会话继续执行。',
    { requestId: text, answer: text }, ['requestId', 'answer']),
  tool('team_complete', '提交本轮成果及依据。普通问答可直接给出最终答复而不调用本工具；若调用，summary 写答复，artifacts 和 verification 可为空。报告任务允许经理独立完成，summary 写实际结论、verification 写检查依据与限制，artifacts 可为空；开发任务必须有成员成果、实际文件和验证证据。已派发成员必须全部结束并通过验收。',
    { summary: text, artifacts: { type: 'array', items: text }, verification: { type: 'array', items: text } }, ['summary', 'artifacts', 'verification'])
];
// 成员只拥有反馈工具，不能借此继续派发其他成员，避免绕过项目经理的协调边界。
const MEMBER_TOOLS = [
  tool('team_ask_manager', '向项目经理提出执行中的问题或阻塞，并等待项目经理回复。问题应包含需要确认的具体事实、当前进度和尝试过的方案；收到回复后继续原任务。',
    { question: text, context: text }, ['question'])
];
const requireText = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be non-empty text up to ${max} characters`);
  return value.trim();
};
function parseManagement(input, managerId, available = ['codex-app-server']) {
  if (!input || !Array.isArray(input.members) || input.members.length < 1 || input.members.length > 200) throw new Error('management.members must contain 1–200 members');
  const ids = new Set();
  const members = input.members.map(member => {
    const id = requireText(member.id, 'member.id', 100);
    if (ids.has(id)) throw new Error('Duplicate member id');
    ids.add(id);
    const adapter = member.provider || 'codex-app-server';
    // 未接入供应商可保留在花名册中；真正派发前明确拒绝，不伪造成功。
    return { id, name: requireText(member.name, 'member.name', 80), role: requireText(member.role, 'member.role', 80),
      description: member.description ? requireText(member.description, 'member.description', 1000) : '', provider: requireText(adapter, 'member.provider', 120),
      model: requireText(member.model || 'default', 'member.model', 120), providerFingerprint: member.providerFingerprint ? requireText(member.providerFingerprint, 'member.providerFingerprint', 64) : undefined, cwd: member.cwd ? requireText(member.cwd, 'member.cwd', 400) : '',
      teamId: member.teamId ? requireText(member.teamId, 'member.teamId', 160) : null, teamName: member.teamName ? requireText(member.teamName, 'member.teamName', 160) : null,
      prompt: member.prompt ? requireText(member.prompt, 'member.prompt', 16000) : '', available: available.includes(adapter) };
  });
  if (!ids.has(managerId)) throw new Error('Coordinator must belong to the team');
  const coordinator = members.find(member => member.id === managerId);
  if (!coordinator || coordinator.role !== 'ProjectManager') {
    throw new Error('项目经理主导需要 coordinator 的 role 为 ProjectManager');
  }
  if (input.deliveryMode != null && !['files', 'report', 'reply'].includes(input.deliveryMode)) throw new Error('Invalid management deliveryMode');
  const concurrency = input.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200) throw new Error('Invalid management concurrency');
  return { members, concurrency, ...parseHierarchy(input, members, managerId), ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}) };
}
function managerInstructions(management, managerId) {
  const roster = dispatchableMembers(management, managerId).map(({ id, name, role, description, available, cwd, teamName }) => ({ id, name, role, description, available, cwd, teamName }));
  const acceptance = management.deliveryMode === 'reply'
    ? '本轮类型：直接答复。用户是在提问或对话，无需开发交付时直接回答问题即可，不强制派发成员、调用工具、修改文件或调用 team_complete。不要为角色模板附加计划、任务表、验收文档或测试；最终答复本身就代表本轮完成。必要时可查阅资料或请成员协助，但已派发的成员必须结束且没有未解决阻塞。缺少需求时可以向用户澄清，不要把提问或问候强行转成开发任务。'
    : management.deliveryMode === 'report'
    ? '本轮成果类型：审查与分析报告。允许项目经理独立调查并提交最终结论，不强制派发成员或创建报告文件，不要为满足开发模板修改项目代码。需要专业复核时才派发成员。报告必须包含结论、位置或依据、影响与建议、实际验证和未验证限制；测试不适用时说明原因，不编造测试。可调用 team_complete（summary 为报告结论，artifacts 可为空，verification 为实际检查依据），再给用户完整最终报告。未调用该工具时，已结束的最终回复也会作为报告提交；进度播报不算成果。'
    : '本轮成果类型：开发与文件交付。规划只是第一步，必须使用 team_dispatch 派发必要成员、接收成果并检查实际文件，执行或核实验证证据，然后调用 team_complete，写明交付物相对路径、验证命令与结果和使用方式。不能只输出计划、审查意见或口头声称完成来替代实现；完成工具成功后再报告最终结果。';
  return `\n\n【本轮真实团队调度协议】
${LIGHTWEIGHT_GUIDANCE}
当前已具备 team_dispatch、team_wait、team_read_result、team_reply_member、team_complete 工具。你对用户要求的最终交付负责；本轮成果要求优先于角色模板中的开发流程。
${acceptance}
需要分工时，用 team_dispatch 指定成员 id 和具体目标、范围、依赖、验收条件；只派发必要成员，不向全员广播。并发上限为 ${management.concurrency}，共享文件有依赖或冲突时必须串行。通过 team_wait 接收已派发成员的结果和执行中的问题；收到成员提问时，必须先用 team_reply_member 给出明确答复或阻塞决定，再继续等待或验收。按需安排返工；有成员未结束、失败、待审批或未处理的问题时不能完成本轮。成员使用各自配置的供应商、模型和指令，不要用引擎自带子代理替代配置的成员。
${management.teams ? '分级调度：你只可派发下面列出的直属成员和直接子团队负责人。派给子团队负责人后，他获得本部门的调度工具、人员与并发上限；你不能绕过负责人派发部门工程师。每级并发上限只统计自己派发的直属任务，等待不轮询。跨部门问题通过直接上级协调；收到下级问题时先处理再验收。' : ''}
成果读取：team_wait.output 是短预览，outputTruncated=true 不表示成员漏写。用 team_read_result(runId) 读取已保存的最终成果，按 nextCursor 继续直到 hasMore=false，再验收或汇总；进展、错误和反馈可通过 section 分别读取。outputUnchanged 仅表示状态已通知，不影响反复读取成果。team_wait 的 hasMore 表示还有现成状态页，带它的 nextCursor 读完；待答问题标记 truncated 时先按 details 读取完整问题再答复。先补读已有内容，仅实际实现或结论有问题才派发返工，不要因为预览较短要求成员重写。旧记录的 legacy-mixed-output 可能包含进展或历史截取，不能把它当作确定完整的最终成果。
可用成员：${JSON.stringify(roster)}
用户已授权任务范围内的工作、验证和必要分工，不要为常规派发重复请求确认。真正缺少信息或权限时明确报告阻塞；审批按原策略处理，不能扩大用户任务范围或绕过权限。`;
}
const memberInstructions = '\n\n【成员反馈协议】\n你可以调用 team_ask_manager 向项目经理询问任务范围、接口约定、取舍或阻塞处理。question 最多 4000 字符，context 最多 6000 字符。提问前说明当前进度、具体问题和已尝试方案；调用后等待回复，status 为 answered 后按答复继续原任务。返回 expired 或 cancelled 时不得猜测答案或继续依赖该答案的工作，应说明阻塞并结束本次执行，等待经理重新安排。不要把普通进展当成提问，也不要自行启动其他成员。经理答复不能替代用户权限审批。';
function createTeamCoordinator({ runs, startRun, cancelRun, emitRun, feedbackTimeoutMs }) {
  const waiters = new Map(), delivered = new WeakMap(), observed = new WeakMap();
  const feedback = createTeamFeedback({ runs, emitRun, timeoutMs: feedbackTimeoutMs });
  const resultReader = createTeamResults({ runs });
  // 给上级的状态签名只包含本人的提问；部门内部问题由部门负责人处理，不无故唤醒更上层。
  const signature = run => `${run.status}:${Boolean(run.cancelRequested)}:${[...(run.approvals?.keys() || [])].join(',')}:${(run.feedback || []).filter(item => !item.memberRunId || item.memberRunId === run.id).map(item => item.requestId + ':' + item.status).join(',')}`;
  // 完成、审批和反馈变化唤醒等待；普通输出不会让经理反复消耗轮次。
  const notifyRunChange = run => {
    if (run) {
      const next = signature(run);
      if (observed.get(run) === next) return;
      observed.set(run, next);
    }
    feedback.synchronize(run);
    const targets = run ? [...new Set([waiters.get(run.id), waiters.get(run.context?.coordinatorRunId)])] : [...waiters.values()];
    for (const checks of targets) for (const check of [...(checks || [])]) check();
  };
  const children = manager => [...runs.values()].filter(run => run.context?.coordinatorRunId === manager.id);
  const snapshot = manager => children(manager).map(memberResult);
  const assertActive = manager => {
    if (TERMINAL_RUN_STATES.has(manager.status) || manager.cancelRequested) throw new Error('本轮调度已结束或停止');
    if (manager.delivery?.status === 'completed') throw new Error('本轮已经提交交付验收，请结束回复');
  };
  const notify = (manager, stage, message) => emitRun(manager, { type: 'coordination', stage, message });
  async function call(manager, name, args, callId) {
    assertActive(manager);
    const management = manager.settings.management;
    if (!management || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid team tool request');
    if (name === 'team_dispatch') {
      const member = dispatchableMembers(management, manager.agentId).find(item => item.id === args.agentId);
      if (!member) throw new Error('只能派发给本轮直属成员或直接子团队负责人，不能越级派发');
      const subManagement = delegatedManagement(management, member.id);
      if (!member.available) throw new Error(`成员 ${member.name} 的供应商 ${member.provider} 尚未接入`);
      const instruction = requireText(args.instruction, 'instruction', 10000);
      const existing = children(manager).find(run => run.context.dispatchCallId === callId);
      if (existing) return { runId: existing.id, status: existing.status };
      if (children(manager).filter(run => !TERMINAL_RUN_STATES.has(run.status)).length >= management.concurrency) throw new Error('已达到成员并发上限，请先 team_wait 接收结果');
      // 沿用同一任务中该成员最近的线程，返工不会丢掉工程上下文。
      const previous = [...runs.values()].filter(run => run.context?.taskId === manager.context.taskId && run.agentId === member.id && run.adapter === member.provider).at(-1);
      if (subManagement && previous?.settings?.management?.deliveryMode) subManagement.deliveryMode = previous.settings.management.deliveryMode;
      manager.delivery = { status: 'running', summary: '成员执行中，等待项目经理验收' };
      const run = await startRun({ agentId: member.id, adapter: member.provider, model: member.model === 'default' && member.provider === manager.adapter ? manager.model : member.model,
        ...(subManagement ? { management: subManagement } : {}),
        providerFingerprint: previous?.settings?.providerFingerprint || member.providerFingerprint,
        cwd: member.cwd || manager.cwd, sandbox: manager.settings.sandbox || DEFAULT_SANDBOX, approvalPolicy: manager.settings.approvalPolicy || 'on-request',
        sandboxPolicy: sandboxPolicy(manager.settings.sandbox || DEFAULT_SANDBOX, path.resolve(member.cwd || manager.cwd)),
        threadId: previous?.threadId || undefined, parentRunId: previous?.id,
        developerInstructions: `${member.prompt}\n\n${LIGHTWEIGHT_GUIDANCE}\n\n本轮由上级负责人通过真实调度器派发。${subManagement ? '你是子团队负责人：只协调本部门子树，按本次分工安排所需成员、处理反馈、验收并向上级交接。可通过 team_ask_manager 向上级咨询跨团队问题。' : '你只执行所分配的工作，不要自行启动其他成员。'}${management.deliveryMode === 'reply' ? '本轮只需答复与必要依据，不为角色模板额外开发。' : management.deliveryMode === 'report' ? '本轮要求审查与分析报告，返回结论、依据和验证限制，不额外修改工程。' : '按分工完成实际产物与验证；方案、设计评审等工作包可提交有依据的报告，不能把计划冒充实现。'}无需为任务范围内已授权的工作重复要求用户确认。`,
        goal: `整体目标：${manager.goal || manager.context.taskTitle}\n\n项目经理分配的子任务：\n${instruction}`.slice(0, 12000),
        context: { ...manager.context, assignment: instruction, agentName: member.name, agentRole: member.role, memberTeamId: member.teamId || manager.context.teamId, memberTeamName: member.teamName || manager.context.teamName, coordinatorRunId: manager.id, dispatchCallId: callId,
          source: { kind: 'agent', id: manager.agentId, name: manager.context.agentName }, dispatchMode: 'delegated',
          handoffFrom: { agentId: manager.agentId, name: manager.context.agentName, runId: manager.id } } });
      notify(manager, 'delegated', `已派发给 ${member.name}：${instruction.slice(0, 180)}`);
      // 停止可能发生在 thread/start 的异步阶段，不能留下游离成员。
      if (manager.cancelRequested || TERMINAL_RUN_STATES.has(manager.status)) await cancelRun(run);
      return { runId: run.id, status: run.status, member: member.name };
    }
    if (name === 'team_read_result') return resultReader.read(manager, args);
    if (name === 'team_wait') {
      if (args.cursor != null) return resultReader.waitPage(manager, args.cursor);
      const all = children(manager), pending = all.filter(run => !TERMINAL_RUN_STATES.has(run.status));
      const seen = delivered.get(manager) || new Map();
      const questions = feedback.requests(manager);
      const unread = all.some(run => (TERMINAL_RUN_STATES.has(run.status) || run.approvals?.size || run.feedback?.some(item => item.status === 'expired')) && seen.get(run.id) !== signature(run));
      const unreadFeedback = questions.length > 0;
      let reason = unread ? 'changed' : 'idle';
      if (unreadFeedback) reason = 'feedback';
      if (pending.length && !unread && !unreadFeedback) {
        const baseline = new Map(all.map(run => [run.id, signature(run)]));
        notify(manager, 'waiting-members', `等待 ${pending.map(run => run.context.agentName).join('、')} 返回结果`);
        reason = await new Promise(resolve => {
          const checks = waiters.get(manager.id) || new Set();
          waiters.set(manager.id, checks);
          const finish = value => { checks.delete(check); if (!checks.size) waiters.delete(manager.id); resolve(value); };
          const check = () => {
            if (manager.cancelRequested || TERMINAL_RUN_STATES.has(manager.status)) finish('cancelled');
            else if (feedback.requests(manager).length) finish('feedback');
            else if (all.some(run => baseline.get(run.id) !== signature(run))) finish('changed');
          };
          // 注册后立即复查，避免等待建立期间发生变化而丢失唤醒。
          checks.add(check); check();
        });
      }
      assertActive(manager);
      const results = snapshot(manager).map(value => {
        const run = runs.get(value.runId), changed = seen.get(run.id) !== signature(run);
        return { ...value, output: changed ? value.output : '', outputUnchanged: !changed,
          feedback: changed ? value.feedback : [] };
      });
      delivered.set(manager, seen);
      if (reason === 'changed') notify(manager, 'reviewing', '成员状态已变化，项目经理继续检查与安排');
      const feedbackAtReturn = feedback.requests(manager);
      const signatures = new Map(children(manager).map(run => [run.id, signature(run)]));
      // 优先返回新状态；只有真正送出的页面被标记，全文始终可以独立重读。
      results.sort((a, b) => Number(a.outputUnchanged) - Number(b.outputUnchanged));
      return resultReader.waitPage(manager, null, { members: results, pending: results.some(run => !TERMINAL_RUN_STATES.has(run.status)), reason,
        feedbackRequests: feedbackAtReturn, deliver: runId => seen.set(runId, signatures.get(runId)) });
    }
    if (name === 'team_reply_member') return feedback.reply(manager, args);
    if (name === 'team_complete') {
      const report = management.deliveryMode === 'report', reply = management.deliveryMode === 'reply', files = !report && !reply;
      const blocked = memberCompletionError(children(manager), files);
      if (blocked) throw new Error(blocked);
      if (manager.approvals?.size) throw new Error('请先处理待审批请求');
      const summary = requireText(args.summary, 'summary', 12000);
      if (!Array.isArray(args.verification) || (!reply && !args.verification.length) || args.verification.length > 100) throw new Error(report ? '必须填写报告的检查依据和验证限制' : '必须填写实际验证命令与结果');
      const verification = args.verification.map(value => requireText(value, 'verification', 3000));
      if (!Array.isArray(args.artifacts) || (files && !args.artifacts.length) || args.artifacts.length > 200) throw new Error('开发任务必须提供实际交付文件的相对路径；问答和报告可使用空文件列表');
      const artifacts = args.artifacts.map(value => {
        const relative = requireText(value, 'artifact', 400), target = path.resolve(manager.cwd, relative);
        const inside = path.relative(manager.cwd, target);
        if (inside.startsWith('..') || path.isAbsolute(inside) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`交付文件不存在或不在任务工作区：${relative}`);
        return relative;
      });
      manager.delivery = { status: 'completed', mode: reply ? 'reply' : report ? 'report' : 'files', summary, artifacts, verification };
      notify(manager, 'accepted', reply ? '项目经理已提交答复' : report ? '项目经理已提交报告与检查依据' : '项目经理已提交交付物与验证证据');
      return manager.delivery;
    }
    throw new Error('Unknown team tool: ' + name);
  }
  function memberCall(member, name, args, callId) {
    if (name !== 'team_ask_manager') throw new Error('Members can only call team_ask_manager');
    return feedback.ask(member, args, callId);
  }
  async function stopChildren(manager) {
    feedback.synchronize();
    const active = children(manager).filter(run => !TERMINAL_RUN_STATES.has(run.status) || run.settings?.management);
    const results = await Promise.allSettled(active.map(cancelRun));
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length) throw new Error(errors.map(result => result.reason.message).join('；'));
  }
  const finalizeReport = manager => {
    if (manager.delivery?.status === 'completed' && manager.settings.management.deliveryMode !== 'reply') return;
    const delivery = reportFromFinalAnswer(manager, children(manager));
    if (delivery) { manager.delivery = delivery; notify(manager, 'accepted', delivery.mode === 'reply' ? '已回复用户问题' : '最终报告已提交'); }
  };
  return { call, memberCall, stopChildren, children, snapshot, notifyRunChange, finalizeReport };
}
module.exports = { TEAM_TOOLS, MEMBER_TOOLS, parseManagement, managerInstructions, memberInstructions, createTeamCoordinator };
