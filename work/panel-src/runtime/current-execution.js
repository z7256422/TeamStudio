/* 工作区级事件订阅，销毁后的迟到响应由共享订阅器丢弃。 */
function watchCurrentExecution({ watchResource, runId, onData, onError }) {
  return watchResource(`/api/runs/${encodeURIComponent(runId)}/execution?view=compact`, {
    onData, onError: error => onError(`执行状态同步失败：${error.message}`)
  });
}
function executionJobs(data) {
  return Object.fromEntries(data.runs.map(run => [run.agentId, { ...conversationJob(run), runId: run.runId,
    output: run.messages?.length ? run.messages.map(message => message.text || '').join('\n\n') : run.output,
    context: run.context, cwd: run.cwd, adapter: run.adapter, createdAt: run.createdAt }]));
}
if (typeof module !== 'undefined' && module.exports) module.exports = { watchCurrentExecution };
