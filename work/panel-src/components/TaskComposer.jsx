/* 仅负责新任务输入区的布局；目录、权限和发送继续使用工作区已有状态与接口。 */
function TaskComposer({ workspace, managerMissing, participants }) {
  const { config, team, task, setTask, taskCwd, setTaskCwd, backend, isRunning, dispatch, activeRun, runHistory } = workspace;
  const primary = team.strategy === 'manager' ? teamCoordinatorAgent(team, participants) : team.strategy === 'current' ? participants[0] : null;
  const ownerTeams = new Map(config.teams.flatMap(entry => entry.agents.map(agent => [agent.id, entry.team])));
  const models = [...new Set((primary ? [primary] : participants).map(agent => effectiveAgentModel(agent, ownerTeams.get(agent.id) || team)))];
  const modelLabel = models.length > 1 ? '多模型' : !models[0] || models[0] === 'default' ? '默认模型' : models[0];
  const sandbox = workspace.taskSandbox || team.sandbox || 'danger-full-access';
  const blocked = isRunning || !task.trim() || backend.state !== 'connected' || managerMissing;
  const directories = [team.cwd, ...runHistory.map(run => run.cwd), ...config.teams.flatMap(entry => [entry.team.cwd, ...entry.agents.map(agent => agent.cwd)])];
  const selectDirectory = value => { setTaskCwd(value); workspace.setTaskStartError(''); };
  const send = event => { event.preventDefault(); if (!blocked) dispatch(); };
  return <div className="composer-wrap task-composer-area">
    <div className="task-composer-context">
      <TaskDirectoryMenu value={taskCwd} onChange={selectDirectory} defaultCwd={team.cwd} directories={directories} disabled={isRunning}/>
      <span className="task-composer-team" title={team.strategy === 'manager' ? `${team.name} · 项目经理按需派发成员` : `${team.name} · ${participants.length} 位成员`}><Icon name="team" size={14}/><span>{team.name}</span></span>
    </div>
    <ProviderDiagnostics workspace={workspace} provider={primary?.provider || team.provider} cwd={effectiveWorkingDirectory(taskCwd, primary?.cwd, team.cwd)} sandbox={sandbox} onSelectSandbox={workspace.setTaskSandbox} onSelectDirectory={selectDirectory} directoryLabel="本次任务工作目录" directoryHint="选择后应用于本次任务。" compact/>
    {workspace.taskStartError && <div className="run-error" role="alert">{workspace.taskStartError}<button type="button" className="text-button" onClick={() => workspace.setView('integrations')}>打开执行环境诊断</button></div>}
    <form className="task-composer task-compose-form" onSubmit={send}>
      <label className="sr-only" htmlFor="task-goal">任务目标</label>
      <textarea id="task-goal" maxLength="12000" value={task} disabled={isRunning} onChange={event => setTask(event.target.value)} placeholder="描述目标、背景和期望交付物…"
        onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) send(event); }}/>
      <div className="task-compose-toolbar">
        <div className="task-compose-permissions">
          <label className="task-compose-setting" title={sandbox === 'danger-full-access' ? '无沙箱：可访问当前 Windows 用户有权限的文件和网络' : '文件权限 · 本次任务与后续续聊沿用'}><Icon name="shield" size={14}/><span className="sr-only">文件权限</span>
            <select id="task-sandbox" disabled={isRunning} value={sandbox} onChange={event => workspace.setTaskSandbox(event.target.value)}>
              <option value="danger-full-access">无沙箱</option><option value="workspace-write">工作区可写</option><option value="read-only">只读</option>
            </select>
          </label>
          <label className="task-compose-setting" title="审批策略 · 本次任务与后续续聊沿用"><Icon name="check" size={14}/><span className="sr-only">审批策略</span>
            <select id="task-approval-policy" disabled={isRunning} value={workspace.taskApprovalPolicy || team.approvalPolicy || 'on-request'} onChange={event => workspace.setTaskApprovalPolicy(event.target.value)}>
              <option value="on-request">按需询问</option><option value="never">从不询问</option><option value="untrusted">仅不受信操作</option>
            </select>
          </label>
        </div>
        <div className="task-compose-submit"><span className="task-compose-model" title={`执行模型：${models.map(model => model === 'default' ? '默认模型' : model).join('、')}`}>{modelLabel}</span>
          {isRunning ? <button type="button" className="btn danger compact" onClick={() => activeRun.current?.cancel()}><Icon name="stop" size={14}/>停止</button> : <button type="submit" className="send-task" disabled={blocked} aria-label="发送任务" title="发送任务 · Ctrl / ⌘ + Enter"><Icon name="up" size={18}/></button>}
        </div>
      </div>
    </form>
    <p className="composer-hint">{backend.state !== 'connected' ? '本机引擎尚未连接，可先编辑任务和配置。' : managerMissing ? '请先在团队配置中设置一名 ProjectManager，再启动项目经理主导任务。' : team.strategy === 'manager' ? '项目经理协调 · 按需派发成员 · 验收交付' : `${STRATEGIES[team.strategy]} · ${participants.length} 位成员`}<span>Ctrl / ⌘ + Enter 发送</span></p>
  </div>;
}
