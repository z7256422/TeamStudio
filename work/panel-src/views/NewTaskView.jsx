/* 任务正文与执行设置分区；显示实际提交目标，输入草稿不会冒充会话消息。 */
function NewTaskView({ workspace }) {
  const { config, team, setTask, jobs, isRunning, executionAgents, agents, selected,
    setSelectedId, updateTeam, setView, switchTeam, submittedTask, setRunAgentId,
    taskCwd } = workspace;
  const [showRoster, setShowRoster] = useState(() => window.innerWidth > 960);
  const conversationRef = useRef(null);
  const followOutput = useRef(true);
  useEffect(() => { followOutput.current = true; }, [submittedTask]);
  useEffect(() => {
    // 在底部时跟随新活动；用户上滚查看旧内容时保持阅读位置。
    const element = conversationRef.current;
    if (element && followOutput.current) element.scrollTop = element.scrollHeight;
  }, [jobs, submittedTask]);
  const participants = team.strategy === 'current' ? [workspace.effectiveSelected] : executionAgents;
  const managerAgent = teamCoordinatorAgent(team, executionAgents);
  const managerMissing = team.strategy === 'manager' && !managerAgent;
  const effectiveDisplayCwd = taskCwd.trim() || (team.strategy === 'current' ? selected.cwd : team.cwd) || '按成员专属目录或本机默认目录';
  const effectiveDisplaySource = taskCwd.trim() ? '由本次任务指定' : team.cwd ? '未指定任务目录，使用团队默认目录' : team.strategy === 'current' && selected.cwd ? '未指定任务目录，使用 Agent 专属目录' : '未指定任务目录，按成员专属目录或控制平面默认目录';
  const activeJobs = submittedTask ? executionAgents.filter(agent => jobs[agent.id]) : [];
  const waiting = activeJobs.some(agent => jobs[agent.id]?.status === 'waiting');
  const suggestions = [
    ['search', '理解一个项目', '分析当前项目的结构与关键模块，梳理主要流程，并列出需要优先关注的问题。'],
    ['terminal', '协作实现功能', '请先拆解需求，制定实现步骤，再协作完成开发和验证。具体需求：'],
    ['check', '审查代码质量', '审查当前项目的代码质量，重点检查正确性、异常处理和可维护性，按影响程度给出建议。']
  ];
  const toolbar = <><div className="conversation-toolbar execution-panel-toolbar"><button className="icon-button" aria-label={showRoster ? '收起执行面板' : '展开执行面板'} aria-expanded={showRoster} onClick={() => setShowRoster(!showRoster)}><Icon name="panel"/></button></div>{workspace.historyError && <p className="run-error history-sync-error" role="alert">{workspace.historyError}</p>}</>;
  if (workspace.taskConversation) return <div className={`task-layout ${showRoster ? '' : 'roster-hidden'}`}>
    <section className="conversation-pane">{toolbar}<RunConversation key={workspace.taskConversation.runId} run={workspace.taskConversation} workspace={workspace} layout="task"/></section>
    {showRoster && <ConversationInspector run={workspace.taskConversation} workspace={workspace}/>}
  </div>;
  return <div className={`task-layout ${showRoster ? '' : 'roster-hidden'}`}>
    <section className="conversation-pane">
      {toolbar}
      {isRunning && <p className="task-running-label">{waiting ? '等待审批 / 输入' : team.strategy === 'manager' ? `项目经理 ${managerAgent?.name || ''} 正在协调，其他成员待命` : '团队正在执行'}</p>}
      {managerMissing && <p className="run-error manager-missing" role="alert">当前团队没有项目经理，无法使用“项目经理主导”。请到团队配置中将一名成员角色设置为 <code>ProjectManager</code>。</p>}
      <div className="conversation-scroll" ref={conversationRef} onScroll={event => {
        const element = event.currentTarget;
        followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
      }}>
        {!activeJobs.length ? <div className="task-welcome"><div className="welcome-mark"><Icon name="layers" size={34}/></div><span className="eyebrow">一起把想法变成结果</span><h2>这次，想让团队完成什么？</h2><p>交给 <strong>{team.name}</strong>，由项目经理安排成员、跟进实现并验收交付。</p><div className="task-suggestions">{suggestions.map(([icon, title, prompt]) => <button key={title} onClick={() => { setTask(prompt); document.getElementById('task-goal')?.focus(); }}><Icon name={icon}/><span>{title}</span><Icon name="arrow" size={14}/></button>)}</div></div> : <div className="task-thread"><article className="user-turn"><span className="eyebrow">你的任务</span><MarkdownContent text={submittedTask}/></article>{activeJobs.map(agent => <article className="agent-turn" key={agent.id}><Avatar name={agent.name}/><div><div className="turn-heading"><b>{agent.name}</b><span className={`badge ${jobs[agent.id].status}`}>{STATES[jobs[agent.id].status]}</span></div><RunProgress job={jobs[agent.id]}/><ExecutionReasoning key={jobs[agent.id].runId || agent.id} job={jobs[agent.id]}/>{workspace.approvals.filter(approval => approval.runId === jobs[agent.id]?.runId).map(approval => <ApprovalCard key={approvalKey(approval)} approval={approval} workspace={workspace}/>)}{jobs[agent.id].output && <MarkdownContent text={jobs[agent.id].output}/>}</div></article>)}</div>}
      </div>
      <TaskComposer workspace={workspace} managerMissing={managerMissing} participants={participants}/>
    </section>
    {showRoster && <aside className="task-inspector"><div className="inspector-heading"><h3>执行面板</h3><span className="badge">本机</span></div><fieldset disabled={isRunning}><Field label="执行团队"><select aria-label="任务执行团队" value={config.activeTeamId} onChange={e => switchTeam(e.target.value)}>{config.teams.map(entry => <option key={entry.id} value={entry.id}>{entry.team.name}</option>)}</select></Field><Field label="协作方式"><select value={team.strategy} onChange={e => updateTeam('strategy', e.target.value)}>{Object.entries(STRATEGIES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>{team.strategy === 'current' && <Field label="执行成员"><select value={selected.id} onChange={e => setSelectedId(e.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>}</fieldset>
      <div className="roster-heading"><span>参与成员</span><span>{participants.length}</span></div><div className="roster-list">{participants.map(agent => <button className="roster-item" key={agent.id} onClick={() => { setRunAgentId(agent.id); setView('runs'); }}><Avatar name={agent.name}/><span className="item-copy"><b>{agent.name}</b><small>{workspace.agentTeamById.get(agent.id)} / {agent.role}</small></span><span className={`status-dot ${jobs[agent.id]?.status || ''}`} title={STATES[jobs[agent.id]?.status || 'idle']}/></button>)}</div>
      <button className="text-button roster-manage" onClick={() => setView('teams')}><Icon name="settings" size={15}/>管理团队配置<Icon name="arrow" size={14}/></button>
      <div className="inspector-bottom"><span className="eyebrow">本次生效目录</span><p><Icon name="file" size={15}/><span>{effectiveDisplayCwd}</span></p><small>{effectiveDisplaySource} · {team.strategy === 'parallel' ? '最多 ' + team.concurrency + ' 位成员同时执行' : STRATEGIES[team.strategy]}</small></div>
    </aside>}
  </div>;
}
