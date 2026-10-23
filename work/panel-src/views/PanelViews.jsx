/* 只挂载当前页面；审批统一由消息中心和所属任务 / 工位展示。 */
function PanelViews({ workspace }) {
  const { view, warning, setWarning, undo, restoreUndo, setUndo } = workspace;
  const View = { teams: TeamsView, team: TeamsView, agents: AgentSettingsView, 'new-task': NewTaskView, integrations: IntegrationsView, runs: RunsView, messages: MessagesView, office: OfficeView }[view] || NewTaskView;
  return <>
    {warning && <div className="notice warning" role="alert"><span>{warning}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setWarning('')}><Icon name="close"/></button></div>}
    {undo && <div className="notice undo-notice" role="status"><span>配置已调整。</span><button className="text-button" onClick={restoreUndo}>撤销这次修改</button><button className="icon-button" aria-label="关闭撤销提示" onClick={() => setUndo(null)}><Icon name="close" size={15}/></button></div>}
    <ExecutionView workspace={workspace} View={View}/>
  </>;
}
function ExecutionView({ workspace, View }) {
  const [jobs, setJobs] = React.useState({});
  const enabled = ['runs', 'office'].includes(workspace.view);
  const live = useCurrentExecution({ runtime: workspace.runtime, connected: enabled && workspace.backend.state === 'connected', conversation: workspace.taskConversation, setJobs });
  const currentAgents = workspace.taskConversation ? live.members.length ? live.members : workspace.currentAgents : workspace.currentAgents;
  return <View workspace={{ ...workspace, currentAgents, jobs: enabled && live.runId ? (live.ready ? jobs : {}) : workspace.jobs, executionSyncError: live.error }}/>;
}
