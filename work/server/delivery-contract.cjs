const { jobFromRunEvent } = require('../shared/run-progress.js');

const UNACCEPTED_DELIVERY = '项目经理本轮已结束，但尚未完成团队交付验收；请在本任务继续处理。';

// 问法不等于执行授权；“如何实现”是咨询，“帮我实现，可以吗”仍是实际工作。
function isDirectQuestion(text) {
  const question = String(text).search(/(?:如何|怎么|怎样|为什么|为何|什么|是否|哪些|多少|哪里|哪种|哪一个|几种|区别|意味着|[吗么呢][？?\s]*$)|^(?:你好|您好|谢谢|感谢|在吗|你是谁|早上好)[！!。.?？\s]*$|\b(?:what|why|how|which|who|where|when|hello|thanks)\b/i);
  if (question < 0) return false;
  // 只把明确的行动请求排除在咨询之外，避免“我想知道如何修复”被当作修复授权。
  const request = /(?:帮我|替我|为我|请(?!问)|麻烦(?:你)?|我(?:想要?|需要|要))\s*(?:先|再|直接|实际|立即|继续|开始|帮我|你)*(?:把.{1,24}?)?(?:实现|编写|修改|修复|调整|新增|增加|删除|替换|重构|优化|开发|搭建|部署|发布|打包|创建|生成|写入|设计|绘制|建模|布线|制作|研发|写|做|建)|\b(?:please|can you|could you)\s+(?:please\s+)?(?:implement|fix|modify|refactor|build|deploy|change|patch|create|write|design|model)\b/i.test(text);
  return !request;
}

// 仅简短“继续”沿用上一轮要求；新问题不能继承开发任务的文件验收门槛。
function resolveDeliveryMode(goal, previous = 'reply') {
  const text = String(goal || '').toLowerCase();
  if (/^(?:继续(?:吧|处理|执行)?|接着(?:来|做)?|开始吧|按计划继续|continue|go on|proceed)[。.!！?？\s]*$/i.test(text.trim())) return ['files', 'report', 'reply'].includes(previous) ? previous : 'reply';
  const actionable = text
    .replace(/(?:不要|无需|不用|不需要|禁止|不允许|不必|不做|不进行|别)(?:直接|实际|自行|任何)?(?:修改|修复|改动|重构|优化|开发|实现|写入|生成|创建|保存)[^，。；,;\n!?！？]*/g, '')
    .replace(/(?:do not|don't|without)\s+(?:modify|change|fix|implement|write|create|save)\b[^,.!;\n]*/gi, '')
    .replace(/(?:修改|修复|重构|优化|开发|实现|设计)(?:建议|方案|思路|原理|方式|细节|情况|质量|后的|过的)/g, '')
    .replace(/(?:当前|已有|现有|刚才|最近|这些|本次|之前)(?:的)?(?:代码)?(?:改动|修改|实现)/g, '')
    .replace(/\b(?:fix|implementation|refactoring)\s+(?:suggestions|recommendations|plan|details)\b/gi, '')
    .split(/[，。；,;\n!?！？]|(?:然后|之后|并且|以及|并|再|和)(?=解释|说明|介绍|帮我|请|修改|修复|实现|部署)/)
    // “解释代码的实现”描述已有代码，不是实现授权；同句追加的开发动作已拆开判断。
    .filter(clause => !isDirectQuestion(clause) && !/^(?:\s|请|帮我|麻烦你|能否|能|先|再|只需|只|简单|详细)*(?:解释|说明|介绍|讲解|讲讲|告诉我|说说)|^(?:please\s+)?(?:explain|describe|tell me)\b/i.test(clause)).join('，');
  if (/(?:实现|编写|修改|修复|改动|调整|新增|增加|删除|替换|重构|优化|开发|搭建|部署|发布|打包)|(?:创建|生成|保存|写入|输出).{0,24}(?:文件|\.md\b|\.txt\b)|(?:写|做|建).{0,12}(?:网页|页面|网站|脚本|程序|应用|系统|接口|功能|文件)|(?:按|照).{0,20}(?:建议|方案|说的).{0,6}(?:做|实施|执行|改)|\b(?:implement|fix|modify|refactor|build|deploy|change|patch)\b|\b(?:create|write|save)\b.{0,30}\b(?:file|script|page|app|application|website|code)\b/.test(actionable)) return 'files';
  if (/(?:设计|绘制|建模|制作|研发|做).{0,20}(?:产品|外壳|机构|结构|机械|电路|原理图|pcb|硬件|界面|原型|图纸|模型|装配)|(?:pcb|电路板).{0,12}布线|\bdesign\b.{0,30}\b(?:product|enclosure|pcb|circuit|interface)\b/.test(actionable)) return 'files';
  if (isDirectQuestion(text)) return 'reply';
  if (/(?:审查|审阅|评审|分析|解释|说明|梳理|调研|咨询|评估|排查|诊断|检查|需求|设计方案|设计思路|可行性|验收标准|给出.{0,12}建议|制定.{0,12}计划)|\b(?:review|audit|analy[sz]e|explain|investigate|assess|prd)\b/.test(text)) return 'report';
  return 'reply';
}

function memberCompletionError(children, requireMembers = false) {
  if (requireMembers && !children.length) return '尚未派发任何成员，不能把项目计划标记为交付完成';
  if (children.some(run => !['completed', 'failed', 'cancelled'].includes(run.status))) return '仍有成员运行，请先等待并验收';
  const latest = new Map(children.map(run => [run.agentId, run]));
  if ([...latest.values()].some(run => run.status !== 'completed')) return '成员最近一轮失败或停止，请解决问题后重新派发';
  if ([...latest.values()].some(run => run.feedback?.some(item => item.status !== 'answered'))) return '成员仍有未解决或超时的反馈，请处理阻塞并重新派发后验收';
  if (children.some(run => run.approvals?.size)) return '成员仍有待处理审批，不能完成任务';
  return '';
}

function reportFromFinalAnswer(run, children) {
  const mode = run.settings?.management?.deliveryMode;
  if (!['reply', 'report'].includes(mode) || run.approvals?.size || memberCompletionError(children)) return null;
  const completion = run.events?.findLast(event => event.type === 'completed');
  const engineCompleted = run.status === 'completed' || (run.status === 'failed' && run.error === UNACCEPTED_DELIVERY && completion?.turn?.status === 'completed');
  if (!engineCompleted || run.cancelRequested) return null;
  // 自定义模型可能没有 phase。仅在引擎明确完成、最后一条消息有结束边界且之后无工具活动时接纳。
  // 不使用混合 output，也不能把显式 commentary 当成最终答复。
  const final = (run.messages || []).findLast(message => message.text?.trim());
  if (!final?.endedAt || !final.text?.trim() || final.phase === 'commentary') return null;
  if (final.phase !== 'final_answer') {
    const endIndex = (run.events || []).findLastIndex(event => event.type === 'provider_event' && event.method === 'item/completed' && event.params?.item?.type === 'agentMessage' && event.params.item.id === final.id);
    if (endIndex < 0 || run.events.slice(endIndex + 1).some(event => (['message_delta', 'tool_output'].includes(event.type) && event.delta) || event.type === 'reasoning_summary' || (event.type === 'provider_event' && ['item/started', 'item/completed'].includes(event.method)))) return null;
  }
  const report = final.text.trim();
  if (mode === 'reply') return { status: 'completed', mode, source: 'final-answer', summary: report.slice(0, 500), reply: report, artifacts: [], verification: [] };
  const completedTools = (run.events || []).filter(event => event.type === 'provider_event' && event.method === 'item/completed'
    && ['commandExecution', 'mcpToolCall', 'webSearch'].includes(event.params?.item?.type)).length;
  return { status: 'completed', mode: 'report', source: 'final-answer',
    summary: report.split('\n').find(line => line.trim()).slice(0, 500), report, artifacts: [],
    verification: [completedTools ? `已记录 ${completedTools} 项工具操作的结束事件；实际结果和验证边界见执行记录及最终报告。` : '未记录工具验证；分析依据和限制见最终报告。'] };
}

// 只修复有明确引擎完成和答复证据的验收误判，不改写真正失败或未完成的开发任务。
function recoverReportDeliveries(runs) {
  for (const run of runs) {
    if (!run.settings?.management || run.status !== 'failed' || run.error !== UNACCEPTED_DELIVERY) continue;
    const completion = (run.events || []).findLast(event => event.type === 'completed' && event.status === 'failed'
      && event.message === UNACCEPTED_DELIVERY && event.turn?.status === 'completed');
    const mode = resolveDeliveryMode(run.goal);
    const recoverable = mode === 'report' ? !run.settings.management.deliveryMode : mode === 'reply' && isDirectQuestion(run.goal);
    if (!completion || !recoverable) continue;
    const manager = { ...run, settings: { ...run.settings, management: { ...run.settings.management, deliveryMode: mode } } };
    const delivery = reportFromFinalAnswer(manager, runs.filter(child => child.context?.coordinatorRunId === run.id));
    if (!delivery) continue;
    run.settings = manager.settings; run.delivery = { ...delivery, recovered: true };
    run.status = 'completed'; run.error = '';
    Object.assign(completion, { status: 'completed', message: '', correctedFrom: `${mode}-rejected-by-file-acceptance` });
    run.progress = jobFromRunEvent(run.progress || {}, completion);
    delete run.progress.output;
  }
  return runs;
}

module.exports = { UNACCEPTED_DELIVERY, resolveDeliveryMode, memberCompletionError, reportFromFinalAnswer, recoverReportDeliveries };
