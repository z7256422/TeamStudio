const { createHash, randomUUID } = require('node:crypto');
const { TERMINAL_RUN_STATES } = require('./run-metadata.cjs');

// 对整个序列化响应限额，而非按汉字个数截取；给引擎的工具输出限制留出余量。
const TOOL_RESULT_BYTES = 6000;
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
function previewText(value, maxBytes = 300) {
  let result = '', bytes = 0;
  for (const character of String(value || '')) {
    const size = jsonBytes(character) - 2;
    if (bytes + size > maxBytes) break;
    result += character; bytes += size;
  }
  return result;
}

// 最终成果和过程消息分开读取。旧数据只能提供已保存的内容，不宣称恢复历史丢失的文字。
function resultDocument(run, section = 'result') {
  const messages = run.messages || [];
  if (section === 'progress') return { source: 'retained-progress', content: messages.filter(item => item.phase === 'commentary').map(item => item.text || '').join('\n\n') };
  if (section === 'feedback') return { source: 'member-feedback', content: JSON.stringify((run.feedback || []).filter(item => !item.memberRunId || item.memberRunId === run.id)) };
  if (section === 'error') return { source: 'error', content: run.error || '' };
  const finals = messages.filter(item => item.phase === 'final_answer' && item.endedAt && item.text);
  if (finals.length) return { source: 'final-answer', content: finals.map(item => item.text).join('\n\n') };
  const last = messages.findLast(item => item.text);
  if (TERMINAL_RUN_STATES.has(run.status) && last?.endedAt && last.phase !== 'commentary') return { source: 'last-completed-message', content: last.text };
  if (run.delivery?.status === 'completed') return { source: 'delivery', content: run.delivery.report || run.delivery.reply || JSON.stringify({ summary: run.delivery.summary, artifacts: run.delivery.artifacts, verification: run.delivery.verification }) };
  if ((!messages.length || messages.every(item => item.id === 'legacy-stream')) && run.output) return { source: 'legacy-mixed-output', content: messages.length ? messages.map(item => item.text).join('\n\n') : run.output };
  return { source: 'none', content: '' };
}

function memberResult(run) {
  const document = resultDocument(run), output = previewText(document.content);
  return { runId: run.id, agentId: run.agentId, name: previewText(run.context?.agentName, 240), status: run.status,
    activity: previewText(run.progress?.activity, 150), error: previewText(run.error, 180),
    errorTruncated: (run.error || '').length > previewText(run.error, 180).length,
    output, outputTruncated: output.length < document.content.length,
    result: { runId: run.id, section: 'result', source: document.source, ready: TERMINAL_RUN_STATES.has(run.status),
      totalChars: document.content.length, readTool: 'team_read_result' },
    feedback: (run.feedback || []).filter(item => (!item.memberRunId || item.memberRunId === run.id) && item.status !== 'pending').slice(-5).map(item => ({ requestId: item.requestId, status: item.status,
      details: { runId: run.id, section: 'feedback', readTool: 'team_read_result' } })) };
}

function feedbackPreview(item) {
  const question = previewText(item.question, 450), context = previewText(item.context, 240);
  return { requestId: item.requestId, memberRunId: item.memberRunId, memberId: item.memberId, memberName: previewText(item.memberName, 240),
    status: item.status, askedAt: item.askedAt, question, context,
    truncated: question.length < (item.question || '').length || context.length < (item.context || '').length,
    details: { runId: item.memberRunId, section: 'feedback', readTool: 'team_read_result' } };
}

function createTeamResults({ runs }) {
  const waitSnapshots = new WeakMap();
  function authorizedRun(manager, runId) {
    if (typeof runId !== 'string' || !runId || runId.length > 200) throw new Error('runId 必须是成员运行标识');
    const run = runs.get(runId), owner = runs.get(run?.context?.coordinatorRunId);
    if (!run || !manager.context?.taskId || run.context?.taskId !== manager.context.taskId || !owner
      || owner.context?.taskId !== manager.context.taskId || owner.agentId !== manager.agentId || !owner.settings?.management) {
      throw new Error('只能读取同一任务中由自己直接派发的成员成果');
    }
    // 续聊可重读自己的历史交接，但不能借相同 agentId 读取另一条分支或越级读取孙团队。
    const visited = new Set();
    for (let current = manager; current && !visited.has(current.id); current = runs.get(current.parentRunId)) {
      if (current.id === owner.id) return run;
      visited.add(current.id);
    }
    throw new Error('该成果不属于当前负责人及其续聊历史');
  }
  function read(manager, args) {
    const run = authorizedRun(manager, args.runId), section = args.section ?? 'result';
    if (!['result', 'progress', 'feedback', 'error'].includes(section)) throw new Error('无效的成果 section');
    const limit = args.maxBytes ?? TOOL_RESULT_BYTES;
    if (!Number.isInteger(limit) || limit < 1024 || limit > TOOL_RESULT_BYTES) throw new Error(`maxBytes 必须为 1024–${TOOL_RESULT_BYTES} 的整数`);
    const document = resultDocument(run, section);
    const revision = createHash('sha256').update(JSON.stringify([run.id, section, document.source, document.content])).digest('hex');
    let offset = 0;
    if (args.cursor != null) {
      if (typeof args.cursor !== 'string' || !/^[a-f0-9]{64}:\d{1,12}$/.test(args.cursor)) throw new Error('无效的成果 cursor，请从不带 cursor 的第一页读取');
      const [version, position] = args.cursor.split(':'); offset = Number(position);
      if (version !== revision) throw new Error('成果内容已经更新或 cursor 不属于此成果，请不带 cursor 重新读取');
      if (offset > document.content.length || (offset > 0 && /[\uD800-\uDBFF]/.test(document.content[offset - 1]) && /[\uDC00-\uDFFF]/.test(document.content[offset] || ''))) throw new Error('成果 cursor 越界');
    }
    const header = { runId: run.id, section, source: document.source, status: run.status, ready: TERMINAL_RUN_STATES.has(run.status),
      totalChars: document.content.length, offset, nextCursor: `${revision}:${document.content.length}`, hasMore: true, content: '' };
    const content = previewText(document.content.slice(offset), limit - jsonBytes(header));
    if (!content && offset < document.content.length) throw new Error('maxBytes 不足以容纳成果元数据，请增大后重试');
    const end = offset + content.length, hasMore = end < document.content.length;
    return { ...header, content, hasMore, nextCursor: hasMore ? `${revision}:${end}` : null };
  }

  // 保存一次唤醒的只读快照；分页是读取现成数据，不建立等待或轮询。
  // 只将实际发出的页面标为已通知，未取走的成员不会被误认为已经看过。
  function waitPage(manager, cursor, snapshot) {
    let offset = 0, saved;
    if (snapshot) {
      saved = { ...snapshot, id: randomUUID(), entries: [...snapshot.feedbackRequests.map(value => ({ kind: 'feedbackRequests', value: feedbackPreview(value) })),
        ...snapshot.members.map(value => ({ kind: 'members', value }))] };
      waitSnapshots.set(manager, saved);
    } else {
      saved = waitSnapshots.get(manager);
      if (typeof cursor !== 'string' || cursor.length > 100 || !saved || !cursor.startsWith(saved.id + ':') || !/^\d+$/.test(cursor.slice(saved.id.length + 1))) throw new Error('等待结果 cursor 已失效，请不带 cursor 调用 team_wait 获取当前状态');
      offset = Number(cursor.slice(saved.id.length + 1));
      if (!Number.isSafeInteger(offset) || offset >= saved.entries.length) throw new Error('等待结果 cursor 越界');
    }
    const result = { members: [], feedbackRequests: [], pending: saved.pending, reason: saved.reason,
      totalMembers: saved.members.length, totalFeedbackRequests: saved.feedbackRequests.length, hasMore: true, nextCursor: `${saved.id}:${saved.entries.length}` };
    let index = offset;
    for (; index < saved.entries.length; index++) {
      const { kind, value } = saved.entries[index];
      result[kind].push(value);
      if (jsonBytes(result) > TOOL_RESULT_BYTES) { result[kind].pop(); break; }
    }
    if (index === offset && index < saved.entries.length) throw new Error('成员状态元数据过大，无法安全返回');
    result.hasMore = index < saved.entries.length;
    result.nextCursor = result.hasMore ? `${saved.id}:${index}` : null;
    for (const member of result.members) saved.deliver(member.runId);
    return result;
  }
  return { read, waitPage };
}

module.exports = { TOOL_RESULT_BYTES, previewText, resultDocument, memberResult, createTeamResults };
