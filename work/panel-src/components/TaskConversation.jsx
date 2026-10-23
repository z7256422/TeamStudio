/* 恢复入口只选择原会话，执行参数由服务端继承，不改写当前团队配置。 */
function TaskConversationPicker({ workspace }) {
  const { taskConversation, runHistory, restoreConversation, newTask, isRunning } = workspace;
  return <div className="task-history-picker"><Icon name="history" size={16}/><select aria-label="选择历史对话" disabled={isRunning} value={taskConversation?.runId || ''} onFocus={workspace.refreshRunHistory} onChange={event => {
    const picked = runHistory.find(run => run.runId === event.target.value);
    if (picked) restoreConversation(picked); else newTask();
  }}><option value="">新建对话 · 选择历史可继续</option>{runHistory.map(run => <option key={run.conversationKey} value={run.runId}>{(run.context?.taskTitle || run.goal || '未命名会话').slice(0, 55)} · {run.context?.agentName || workspace.agentNameById.get(run.agentId) || run.agentId} · {run.turnCount} 轮</option>)}</select>{taskConversation && <button className="text-button" onClick={newTask} disabled={isRunning}>新建对话</button>}</div>;
}

function ConversationInspector({ run, workspace }) {
  const managed = !!run.coordination;
  const name = run.context?.agentName || workspace.agentNameById.get(run.agentId) || run.agentId;
  return <aside className="task-inspector restored-inspector"><div className="inspector-heading"><h3>原会话配置</h3><span className="badge">沿用</span></div><div className="restored-member"><Avatar name={name}/><div><b>{name}</b><small>{run.context?.agentRole || '原执行成员'}</small></div></div>
    <dl>{[['文件权限', run.sandbox === 'danger-full-access' ? '无沙箱' : run.sandbox === 'read-only' ? '只读' : run.sandbox === 'workspace-write' ? '工作区可写' : '沿用引擎原设置'], ['所属团队', run.context?.teamName || '未记录'], ['执行方式', managed ? (run.coordination.mode === 'reply' ? '项目经理答疑' : run.coordination.mode === 'report' ? '项目经理审查与报告' : '项目经理管理与交付') : '与原成员连续对话'], ['执行接口', run.adapter], ['模型', run.model && run.model !== 'default' ? run.model : '沿用原会话模型'], ['工作目录', run.cwd || '原会话目录']].map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>
    <p className="restored-config-hint">原会话的角色指令和执行设置继续生效。当前团队的成员增删、模型和提示词修改不会自动替换它们。</p><p className="restored-config-hint">MCP、skills 的实际可用能力由当前本机引擎配置决定。</p>
    <button className="btn" onClick={() => workspace.setView('office')}><Icon name="office" size={16}/>查看办公室</button>
    <div className="inspector-bottom"><span className="eyebrow">恢复历史对话</span><p>选择历史只加载对话，发送新的要求后开始执行。项目经理主导任务会按需要继续派发成员，沿用已保存的团队快照。</p></div>
  </aside>;
}
