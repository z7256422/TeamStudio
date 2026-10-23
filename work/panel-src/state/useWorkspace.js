const { useEffect, useRef, useState } = React;
function useWorkspace() {
  const [loaded] = useState(loadConfig);
  const [config, setConfig] = useState(loaded.config);
  const [savedConfig, setSavedConfig] = useState(loaded.saved ? JSON.stringify(loaded.config) : '');
  const [warning, setWarning] = useState(loaded.warning);
  const [selectedId, setSelectedId] = useState(() => loaded.config.teams.find(entry => entry.id === loaded.config.activeTeamId)?.agents[0].id);
  const [sizeDraft, setSizeDraft] = useState(() => String(loaded.config.teams.find(entry => entry.id === loaded.config.activeTeamId)?.agents.length || 1));
  const [task, setTask] = useState('');
  // 当前任务可临时覆盖团队与成员的默认目录，便于同一团队处理不同项目。
  const [taskCwd, setTaskCwd] = useState(() => loaded.config.teams.find(entry => entry.id === loaded.config.activeTeamId)?.team.cwd || '');
  const [taskSandbox, setTaskSandbox] = useState('');
  // 任务级审批策略只影响本次启动；续聊由服务端沿用已保存的运行快照。
  const [taskApprovalPolicy, setTaskApprovalPolicy] = useState('');
  const [taskStartError, setTaskStartError] = useState('');
  const [submittedTask, setSubmittedTask] = useState('');
  const [runAgentId, setRunAgentId] = useState(null);
  const [jobs, setJobs] = useState({});
  const [logs, setLogs] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [toast, setToast] = useState('');
  const [undo, setUndo] = useState(null);
  const [filter, setFilter] = useState('');
  const [backend, setBackend] = useState({ state: 'checking', health: null, error: '' });
  const [catalog, setCatalog] = useState({ skills: [], mcp: [], loaded: false });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [approvals, setApprovals] = useState([]);
  const [approvalError, setApprovalError] = useState('');
  const approvalInFlight = useRef(new Set()), resolvedApprovals = useRef(new Set());
  const [runHistory, setRunHistory] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [taskConversation, setTaskConversation] = useState(null);
  const [runHistoryFocus, setRunHistoryFocus] = useState(null);
  const historyTarget = useRef(null);
  const historyRevision = useRef(0);
  const [messages, setMessages] = useState([]);
  const [messageDraft, setMessageDraft] = useState('');
  const [messageTo, setMessageTo] = useState('broadcast');
  const [view, setView] = useState('new-task');
  const [teamSettingsTab, setTeamSettingsTab] = useState('general');
  const [interfaceDialog, setInterfaceDialog] = useState(false);
  const [interfaceDraft, setInterfaceDraft] = useState(null);
  const [exportText, setExportText] = useState('');
  const exportDialog = useRef(null);
  const exportField = useRef(null);
  const interfaceDialogRef = useRef(null);
  const runtime = useRef(null);
  const activeRun = useRef(null);
  const busy = useRef(false);
  const fileInput = useRef(null);
  const activeTeamEntry = config.teams.find(entry => entry.id === config.activeTeamId) || config.teams[0];
  const { team, agents } = activeTeamEntry;
  const ownerTeamByAgentId = new Map(config.teams.flatMap(entry => entry.agents.map(agent => [agent.id, entry.team])));
  const collectTeamAgents = rootId => collectEffectiveAgentsInTree(config.teams, rootId);
  const executionAgents = collectTeamAgents(config.activeTeamId);
  const selected = agents.find(a => a.id === selectedId) || agents[0];
  const effectiveSelected = resolveAgentConfiguration(selected, team);
  const effectiveAgents = agents.map(agent => resolveAgentConfiguration(agent, team));
  const openTeamSettings = section =>
  {
    setTeamSettingsTab(section);
    setView('teams');
  };
  const dirty = JSON.stringify(config) !== savedConfig;
  const capabilityOptions = getCapabilityOptions(catalog);
  // 新建、批量增员、导入和目录延迟到达均走同一同步逻辑；运行期间不修改配置。
  useEffect(() => {
    if (!isRunning) setConfig(current => syncConfigCapabilities(current, getCapabilityOptions(catalog)));
  }, [config, catalog, isRunning]);
  const refreshRunHistory = async snapshot => {
    const revision = ++historyRevision.current;
    const prefix = window.location.protocol === 'file:' ? 'http://127.0.0.1:3210' : '';
    try {
      const response = Array.isArray(snapshot) ? null : await fetch(`${prefix}/api/conversations`, { signal: AbortSignal.timeout(8000) });
      const body = Array.isArray(snapshot) ? { data: [...snapshot] } : await response.json();
      if ((!response || response.ok) && Array.isArray(body.data)) {
        // 从办公室进入的任意一轮都定位到所属会话，超过列表窗口时单独补取。
        const focused = historyTarget.current;
        if (focused && !body.data.some(run => run.runIds.includes(focused))) {
          const detail = await fetch(`${prefix}/api/runs/${encodeURIComponent(focused)}/conversation?view=compact&limit=1`, { signal: AbortSignal.timeout(8000) });
          if (detail.ok) body.data.push((await detail.json()).data.summary);
        }
        if (revision === historyRevision.current) {
          setRunHistory(body.data); setHistoryError('');
          setTaskConversation(current => current ? body.data.find(run => run.runIds.includes(current.runId)) || current : null);
        }
      } else throw new Error(body.error?.message || '无法读取历史会话');
    } catch (error) { if (revision === historyRevision.current) setHistoryError(`历史同步失败：${error.message}`); }
  };
  const prefix = window.location.protocol === 'file:' ? 'http://127.0.0.1:3210' : '';
  const removeHistory = async (runId = null) => {
    const result = await runtime.current.request(runId ? `/api/runs/${encodeURIComponent(runId)}/conversation` : '/api/conversations?scope=finished', { method: 'DELETE' });
    const removed = new Set(result.deletedIds);
    ++historyRevision.current;
    if (removed.has(historyTarget.current)) historyTarget.current = null;
    setRunHistory(current => current.filter(run => !removed.has(run.runId)));
    setTaskConversation(current => current && removed.has(current.runId) ? null : current);
    setJobs(current => Object.fromEntries(Object.entries(current).filter(([, job]) => !removed.has(job.runId))));
    setToast(`已删除 ${result.deletedConversations} 个会话及其对话记录`);
    return result;
  };
  const viewRun = runId => { historyTarget.current = runId; setRunHistoryFocus(runId); refreshRunHistory(); setView('runs'); };
  const consumeRunHistoryFocus = () => setRunHistoryFocus(null);
  const restoreConversation = conversation => {
    if (busy.current) { setToast('请等待当前团队任务结束后再切换会话'); return; }
    historyTarget.current = conversation.runId;
    // 先清除上一任务的本地投影，工作区订阅会按新任务重新同步成员状态。
    setJobs({}); setTaskConversation(conversation); setView('new-task');
  };

  // 刷新按钮与初次加载使用同一条请求路径，目录失败不冒充引擎离线。
  const refreshCatalog = async () => {
    if (catalogLoading) return;
    setCatalogLoading(true); setCatalogError('');
    try {
      const healthResponse = await fetch(`${prefix}/api/health`);
      const health = await healthResponse.json();
      if (!healthResponse.ok) throw new Error(health.error?.message || '控制平面不可用');
      setBackend({ state: 'connected', health, error: '' });
    } catch (error) {
      setBackend({ state: 'offline', health: null, error: error.message });
      setCatalogLoading(false); return;
    }
    try {
      const request = async (route, body) => {
        const response = await fetch(`${prefix}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || '能力目录读取失败');
        return result.data?.data || result.data || [];
      };
      const results = await Promise.allSettled([
        request('/api/codex/skills', { cwd: team.cwd || undefined }),
        request('/api/codex/mcp', { detail: 'toolsAndAuthOnly' })
      ]);
      const [skills, mcp] = results;
      setCatalog(current => ({
        skills: skills.status === 'fulfilled' ? skills.value.flatMap(entry => entry.skills || (entry.name ? [entry] : [])) : current.skills,
        mcp: mcp.status === 'fulfilled' ? mcp.value : current.mcp,
        loaded: results.every(result => result.status === 'fulfilled')
      }));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
      if (errors.length) setCatalogError(errors.join('；'));
    } catch (error) { setCatalogError(error.message); }
    finally { setCatalogLoading(false); }
  };
  useEffect(() => {
    runtime.current = new ControlPlaneRuntime();
    refreshCatalog();
    return () => { ++historyRevision.current; runtime.current.close(); if (!activeRun.current?.serverManaged) activeRun.current?.cancel(); };
  }, []);
  useEffect(() => {
    if (backend.state !== 'connected') return undefined;
    return runtime.current.watchResource('/api/providers', {
      onData: providers => {
        setBackend(current => ({ ...current, health: { ...current.health, providers } }));
        setConfig(current => {
          const directory = new Map(current.providers.map(provider => [provider.id, provider.id.startsWith('custom-') ? { ...provider, status: 'unavailable' } : provider]));
          // 服务端目录只复制公开字段；不把 URL 或凭据写入浏览器团队配置。
          for (const provider of providers) directory.set(provider.id, { id: provider.id, kind: provider.kind, label: provider.label, status: provider.status });
          const next = [...directory.values()];
          return JSON.stringify(next) === JSON.stringify(current.providers) ? current : { ...current, providers: next };
        });
      },
      onError: error => setCatalogError(`模型连接目录同步失败：${error.message}`)
    });
  }, [backend.state]);
  useEffect(() => {
    if (backend.state !== 'connected') return undefined;
    return runtime.current.watchResource('/api/approvals', {
      onData: result => { setApprovals(result.filter(item => !resolvedApprovals.current.has(approvalKey(item)))); setApprovalError(''); },
      onError: error => setApprovalError(`审批同步失败：${error.message}`)
    });
  }, [backend.state]);
  // 最近任务在所有页面订阅历史变化，纯文字增量不重复读取整份历史。
  useEffect(() => {
    if (backend.state !== 'connected') return;
    return runtime.current.watchResource('/api/conversations', {
      onData: refreshRunHistory, onError: error => setHistoryError(`历史同步失败：${error.message}`)
    });
  }, [backend.state]);
  useEffect(() => {
    if (backend.state !== 'connected') return undefined;
    return runtime.current.watchResource('/api/messages', {
      onData: data => { if (Array.isArray(data)) setMessages(data.slice(-300)); },
      onError: error => setToast(`成员消息同步失败：${error.message}`)
    });
  }, [backend.state, prefix]);
  useEffect(() => { setSizeDraft(String(agents.length)); }, [agents.length]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (exportText) exportDialog.current?.showModal(); }, [exportText]);
  useEffect(() => { if (interfaceDialog) interfaceDialogRef.current?.showModal?.(); }, [interfaceDialog]);
  const addLog = (message, kind = '配置') => setLogs(list => [{ id: crypto.randomUUID(), time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message, kind }, ...list].slice(0, 100));
  const sendMessage = async () => {
    if (!messageDraft.trim()) { setToast('请先输入消息'); return; }
    try {
      const response = await fetch(`${prefix}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromAgentId: selected.id, toAgentId: messageTo === 'broadcast' ? null : messageTo, runId: null, content: messageDraft.trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || '消息发送失败');
      setMessages(current => current.some(item => item.id === body.data.id) ? current : [...current, body.data].slice(-300));
      setMessageDraft(''); addLog(`已从「${selected.name}」发送一条${messageTo === 'broadcast' ? '团队广播' : '成员消息'}`, '消息');
    } catch (error) { setToast(error.message); }
  };
  const openInterfaceDialog = () => {
    setInterfaceDraft({ provider: team.provider, model: team.model, cwd: team.cwd, approvalPolicy: team.approvalPolicy });
    setInterfaceDialog(true);
  };
  const closeInterfaceDialog = () => { interfaceDialogRef.current?.close(); setInterfaceDialog(false); setInterfaceDraft(null); };
  const updateInterfaceDraft = (key, value) => setInterfaceDraft(current => current ? { ...current, [key]: value } : current);
  const commitInterfaceDraft = () => {
    if (!interfaceDraft) return;
    try {
      const next = validateConfig({ ...config, teams: config.teams.map(entry => entry.id === config.activeTeamId ? { ...entry, team: { ...entry.team, ...interfaceDraft } } : entry) });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      if (taskCwd === team.cwd) setTaskCwd(interfaceDraft.cwd || '');
      setConfig(next); setSavedConfig(JSON.stringify(next)); setWarning('');
      setToast('接口配置已保存');
      closeInterfaceDialog();
    } catch (error) { setWarning(`未能保存接口配置：${error.message}`); }
  };
  const publishAgentMessage = async (fromAgentId, content, runId = null) => {
    if (!content?.trim()) return;
    try {
      const response = await fetch(`${prefix}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromAgentId, toAgentId: null, runId, content: content.trim().slice(-20000), priority: 'normal' }) });
      const body = await response.json();
      if (response.ok && body.data) setMessages(current => current.some(item => item.id === body.data.id) ? current : [...current, body.data].slice(-300));
    } catch { /* 消息广播失败不应中断 Agent 运行。 */ }
  };
  const updateTeam = (key, value) => {
    // 只有任务目录仍跟随团队默认时才同步修改，用户手动指定的任务目录必须保留。
    if (key === 'cwd' && taskCwd === team.cwd) setTaskCwd(value);
    setConfig(c => ({ ...c, teams: c.teams.map(entry => entry.id === c.activeTeamId ? { ...entry, team: CAPABILITY_KEYS.includes(key) ? setCapabilities(entry.team, key, value) : { ...entry.team, [key]: value } } : entry) }));
  };
  const descendantsOf = rootId => {
    const descendants = new Set();
    const visit = id => {
      const entry = config.teams.find(item => item.id === id);
      (entry?.team.children || []).forEach(childId => {
        if (descendants.has(childId)) return;
        descendants.add(childId); visit(childId);
      });
    };
    visit(rootId);
    return descendants;
  };
  const toggleTeamChild = childId => {
    const current = new Set(team.children || []);
    if (current.has(childId)) {
      current.delete(childId);
    } else {
      if (childId === config.activeTeamId || descendantsOf(config.activeTeamId).has(childId) || descendantsOf(childId).has(config.activeTeamId)) {
        setToast('不能把团队自己或它的下级团队再次包含进来'); return;
      }
      const owner = config.teams.find(entry => entry.id !== config.activeTeamId && (entry.team.children || []).includes(childId));
      if (owner) { setToast(`「${owner.team.name}」已经包含这个团队，请先解除原有关系`); return; }
      current.add(childId);
    }
    setConfig(c => ({ ...c, teams: clampTreeConcurrency(c.teams.map(entry => entry.id === c.activeTeamId ? { ...entry, team: { ...entry.team, children: [...current] } } : entry)) }));
  };
  const updateAgent = (key, value) => setConfig(c => ({ ...c, teams: c.teams.map(entry => entry.id === c.activeTeamId ? { ...entry, agents: entry.agents.map(a => a.id === selected.id ? (CAPABILITY_KEYS.includes(key) ? setAgentCapabilities(a, key, value) : { ...a, [key]: value, ...(['provider', 'model'].includes(key) ? { connectionMode: 'custom' } : {}) }) : a) } : entry) }));
  const selectAllCapabilities = key => setConfig(c => ({ ...c, teams: c.teams.map(entry => entry.id === c.activeTeamId ? {
    ...entry, agents: entry.agents.map(agent => agent.id === selected.id ? setAgentCapabilities(agent, key,
      [...agent[key], ...capabilityOptions[key]], 'all') : agent)
  } : entry) }));
  const setAgentMode = (group, mode) =>
  {
    if (busy.current || isRunning) return;
    setConfig(current => ({ ...current, teams: current.teams.map(entry => entry.id === current.activeTeamId ? {
      ...entry, agents: entry.agents.map(agent => agent.id === selected.id ? setAgentConfigurationMode(agent, entry.team, group, mode) : agent)
    } : entry) }));
  };
  const selectAllTeamCapabilities = key =>
  {
    if (busy.current || isRunning) return;
    setConfig(current => ({ ...current, teams: current.teams.map(entry => entry.id === current.activeTeamId ? {
      ...entry, team: setCapabilities(entry.team, key, [...(entry.team[key] || []), ...capabilityOptions[key]], 'all')
    } : entry) }));
  };
  const applyTeamConfiguration = group =>
  {
    if (busy.current || isRunning) return;
    setUndo({ config, selectedId });
    setConfig(current => ({ ...current, teams: current.teams.map(entry => entry.id === current.activeTeamId ? applyTeamSettingsToMembers(entry, group) : entry) }));
    setToast(`已让 ${agents.length} 位直属成员沿用团队${group === 'connection' ? '执行接口' : '工具与能力'}，点击“保存更改”后保留`);
  };
  const switchTeam = teamId => {
    if (busy.current || teamId === config.activeTeamId) return;
    const next = config.teams.find(entry => entry.id === teamId);
    if (!next) return;
    setConfig(c => ({ ...c, activeTeamId: teamId }));
    setSelectedId(next.agents[0].id); setTaskCwd(next.team.cwd || ''); setFilter(''); setMessageTo('broadcast');
    addLog(`已切换到团队「${next.team.name}」`, '团队');
  };
  const createCompany = () => {
    if (busy.current || isRunning) return;
    try {
      const next = addProductCompany(config, team), root = next.teams.find(entry => entry.id === next.activeTeamId);
      setUndo({ config, selectedId }); setConfig(next); setSelectedId(root.agents[0].id); setTaskCwd(root.team.cwd || ''); setFilter('');
      setToast('已添加 7 个团队、28 位成员；可编辑或撤销，点击保存后留在本机');
      addLog('已添加 28 人产品研发公司，原有团队保留', '团队');
    } catch (error) { setToast(error.message); }
  };
  const createTeam = (duplicate = false) => {
    if (busy.current || config.teams.length >= MAX_TEAMS) { setToast(`最多配置 ${MAX_TEAMS} 个团队`); return; }
    const next = duplicate ? makeTeam(config.teams.length, activeTeamEntry) : makeTeam(config.teams.length);
    setConfig(c => ({ ...c, activeTeamId: next.id, teams: [...c.teams, next] }));
    setSelectedId(next.agents[0].id); setTaskCwd(next.team.cwd || ''); setJobs({}); setFilter(''); setView('team');
    addLog(`${duplicate ? '已复制' : '已创建'}团队「${next.team.name}」`, '团队');
    setToast(`${duplicate ? '团队副本' : '新团队'}已创建`);
  };
  const deleteTeam = () => {
    if (busy.current) return;
    if (config.teams.length === 1) { setToast('至少保留一个团队'); return; }
    if (!window.confirm(`确定删除团队「${team.name}」吗？该团队的成员配置不会保留。`)) return;
    const remaining = removeTeamFromTree(config.teams, config.activeTeamId);
    setUndo({ config, selectedId });
    const next = remaining[0];
    setConfig(c => ({ ...c, activeTeamId: next.id, teams: remaining }));
    setSelectedId(next.agents[0].id); setTaskCwd(next.team.cwd || ''); setJobs({}); setView('team');
    addLog(`已删除团队「${team.name}」`, '团队');
    setToast('团队已删除');
  };
  const replaceAgents = next => {
    setUndo({ config, selectedId });
    setConfig(c => ({ ...c, teams: clampTreeConcurrency(c.teams.map(entry => entry.id === c.activeTeamId ? { ...entry, agents: next } : entry)) }));
    const nextIds = new Set(next.map(a => a.id));
    setJobs(current => Object.fromEntries(Object.entries(current).filter(([id]) => nextIds.has(id))));
    if (!next.some(a => a.id === selectedId)) setSelectedId(next[0].id);
  };
  const resizeTeam = () => {
    const size = Number(sizeDraft);
    if (!Number.isInteger(size) || size < 1 || size > MAX_AGENTS) { setToast(`请输入 1–${MAX_AGENTS} 的整数`); return; }
    if (size === agents.length) return;
    const next = size < agents.length ? agents.slice(0, size) : [...agents, ...Array.from({ length: size - agents.length }, (_, i) => makeAgent(agents.length + i))];
    replaceAgents(next);
    addLog(`团队成员从 ${agents.length} 调整为 ${size}`);
    setToast(size < agents.length ? '已从列表末尾减少成员，可撤销' : `已调整为 ${size} 个成员`);
  };
  const addAgent = () => {
    if (agents.length >= MAX_AGENTS) { setToast(`当前面板最多管理 ${MAX_AGENTS} 个成员`); return; }
    const agent = makeAgent(agents.length);
    replaceAgents([...agents, agent]);
    setSelectedId(agent.id);
    setFilter('');
    addLog(`已添加 ${agent.name}`);
  };
  const removeAgent = () => {
    if (agents.length === 1) { setToast('至少保留一个成员'); return; }
    if (!window.confirm(`确定移除「${selected.name}」吗？保存后可通过导入备份恢复。`)) return;
    replaceAgents(agents.filter(a => a.id !== selected.id));
    addLog(`已移除 ${selected.name}`);
    setToast('成员已移除，可撤销');
  };
  const restoreUndo = () => {
    setConfig(undo.config);
    setSelectedId(undo.selectedId);
    const restoredTeam = undo.config.teams.find(entry => entry.id === undo.config.activeTeamId) || undo.config.teams[0];
    setTaskCwd(restoredTeam?.team.cwd || '');
    setUndo(null);
    setToast('已恢复调整前的团队配置');
  };
  const save = () => {
    try {
      const next = validateConfig(config);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setConfig(next); setSavedConfig(JSON.stringify(next));
      setWarning('');
      setToast('配置已保存到当前浏览器');
    } catch (error) { setWarning(`未能保存：${error.message}。也可以导出配置备份。`); }
  };
  const exportConfig = () => {
    try {
      const next = validateConfig(config);
      setExportText(JSON.stringify(next, null, 2));
      setToast('');
    } catch (error) { setToast(`无法导出：${error.message}`); }
  };
  const downloadConfig = () => {
    try {
      const url = URL.createObjectURL(new Blob([exportText], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'agent-team-config.json'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast('已请求下载；也可以复制下方 JSON 保存为文件');
    } catch (error) { setToast(`无法下载：${error.message}。请复制配置文本。`); }
  };
  const copyConfig = async () => {
    try { await navigator.clipboard.writeText(exportText); setToast('JSON 已复制'); }
    catch { exportField.current.focus(); exportField.current.select(); setToast('已选中 JSON，请按 Ctrl+C 或长按复制'); }
  };
  const importConfig = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (busy.current) { setToast('请先停止运行再导入'); return; }
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('配置文件不得超过 8 MB');
      const next = validateConfig(JSON.parse(await file.text()));
      if (busy.current) throw new Error('任务运行中，请稍后重新导入');
      setUndo({ config, selectedId });
      const importedTeam = next.teams.find(entry => entry.id === next.activeTeamId) || next.teams[0];
      setConfig(next); setSelectedId(importedTeam.agents[0].id); setTaskCwd(importedTeam.team.cwd || ''); setJobs({}); setFilter(''); setWarning('');
      addLog(`已导入 ${next.teams.length} 个团队，当前为「${importedTeam.team.name}」`);
      setToast('配置已导入，点击保存可留在本机；也可撤销');
    } catch (error) { setToast(`导入失败：${error.message}`); }
  };
  // 新任务清空输入与对话，运行阅读器仍保留上一轮输出。
  const newTask = () => {
    if (!busy.current) { setJobs({}); setTaskStartError(''); setTaskConversation(null); setTask(''); setTaskCwd(team.cwd || ''); setTaskSandbox(''); setTaskApprovalPolicy(''); setSubmittedTask(''); setRunAgentId(null); }
    setView('new-task');
  };
  const dispatch = () => {
    if (busy.current) return;
    setTaskStartError('');
    if (!task.trim()) { setToast('请先填写任务目标'); return; }
    try { validateConfig(config); } catch (error) { setToast(`请先完善配置：${error.message}`); return; }
    // 项目经理主导模式只创建一个真实运行，由服务端提供实际成员派发工具；
    // 其他成员仍保留在执行面板中显示为待命，不伪造 queued run。
    const coordinatorAgent = teamCoordinatorAgent(team, team.leaderId ? effectiveAgents : executionAgents);
    if (team.strategy === 'manager' && !coordinatorAgent) {
      setToast('项目经理主导需要至少一名角色为 ProjectManager 的成员，请先到团队配置中设置项目经理');
      return;
    }
    const members = team.strategy === 'current' ? [effectiveSelected] : team.strategy === 'manager' ? [coordinatorAgent] : executionAgents;
    const taskGoal = task.trim();
    const effectiveTaskCwd = taskCwd.trim();
    const taskId = crypto.randomUUID(), queuedAt = new Date().toISOString();
    const taskContext = agent => {
      const owner = config.teams.find(entry => entry.agents.some(member => member.id === agent.id));
      return { taskId, roundId: taskId, taskTitle: taskGoal, teamId: activeTeamEntry.id, teamName: team.name,
        memberTeamId: owner?.id, memberTeamName: owner?.team.name, agentName: agent.name, agentRole: agent.role,
        coordinatorAgentId: coordinatorAgent?.id || agent.id, coordinatorAgentName: coordinatorAgent?.name || agent.name,
        source: { kind: 'user', name: '本机用户' }, dispatchMode: team.strategy, expectedAgentIds: team.strategy === 'manager' ? null : members.map(member => member.id) };
    };
    // 运行能力以控制平面健康检查返回的 Provider 为准。配置中的 planned
    // Provider 或尚未在服务端注册的自定义 Provider 都不能直接启动任务。
    const availableAdapters = new Set((backend.health?.providers || [])
      .filter(provider => provider.status === 'available')
      .map(provider => provider.id));
    const unsupported = members.find(agent => !availableAdapters.has(agent.provider || team.provider));
    if (unsupported) { setToast(`「${unsupported.name}」使用的 Provider 尚未接入本机运行适配器`); setView('integrations'); return; }
    if (team.strategy === 'manager') {
      let management;
      try { management = teamManagementSnapshot(team, executionAgents, effectiveTaskCwd, config.teams); }
      catch (error) { setToast(error.message); return; }
      // 服务端持有整个协作周期；页面只展示记录，刷新和离开页面不停止成员。
      busy.current = true; setIsRunning(true); setSubmittedTask(taskGoal); setTask(''); setUndo(null);
      setJobs({ [coordinatorAgent.id]: { status: 'starting', context: taskContext(coordinatorAgent), createdAt: queuedAt } });
      const ready = runtime.current.request('/api/runs', { method: 'POST', body: JSON.stringify({
        agentId: coordinatorAgent.id, adapter: coordinatorAgent.provider || team.provider,
        model: effectiveAgentModel(coordinatorAgent, ownerTeamByAgentId.get(coordinatorAgent.id) || team),
        goal: taskGoal, cwd: effectiveWorkingDirectory(effectiveTaskCwd, coordinatorAgent.cwd, ownerTeamByAgentId.get(coordinatorAgent.id)?.cwd, team.cwd) || undefined,
        developerInstructions: coordinatorAgent.prompt, approvalPolicy: taskApprovalPolicy || team.approvalPolicy, sandbox: taskSandbox || team.sandbox || 'danger-full-access',
        management, context: taskContext(coordinatorAgent)
      }) }, 150000);
      const controller = { serverManaged: true, cancel: async () => { const run = await ready; await runtime.current.request(`/api/runs/${run.runId}/cancel`, { method: 'POST' }); } };
      activeRun.current = controller;
      ready.then(run => {
        historyTarget.current = run.runId; setTaskConversation(run); setRunAgentId(run.agentId); refreshRunHistory();
        addLog('项目经理已接收任务，将按需派发成员并验收交付物', '运行');
      }).catch(error => { setTask(taskGoal); setSubmittedTask(''); setTaskStartError(error.message); setToast(error.message); setJobs(current => ({ ...current, [coordinatorAgent.id]: { ...current[coordinatorAgent.id], status: 'failed', error: error.message } })); })
        .finally(() => { busy.current = false; setIsRunning(false); if (activeRun.current === controller) activeRun.current = null; });
      return;
    }
    busy.current = true; setIsRunning(true); setUndo(null);
    setSubmittedTask(taskGoal); setTask(''); setRunAgentId(members[0].id);
    setJobs(Object.fromEntries(members.map(agent => [agent.id, { status: 'queued', context: taskContext(agent), createdAt: queuedAt }])));
    // 后续派发、接力与并发由服务端持久队列负责，刷新或关闭页面不会停止它。
    const ready = runtime.current.request('/api/tasks', { method: 'POST', body: JSON.stringify({
      strategy: team.strategy, concurrency: team.concurrency,
      members: members.map(agent => ({ agentId: agent.id, adapter: agent.provider || team.provider,
        model: effectiveAgentModel(agent, ownerTeamByAgentId.get(agent.id) || team), goal: taskGoal,
        cwd: effectiveWorkingDirectory(effectiveTaskCwd, agent.cwd, ownerTeamByAgentId.get(agent.id)?.cwd, team.cwd) || undefined,
        developerInstructions: agent.prompt, approvalPolicy: taskApprovalPolicy || team.approvalPolicy,
        sandbox: taskSandbox || team.sandbox || 'danger-full-access', context: taskContext(agent) }))
    }) }, 150000);
    const controller = { serverManaged: true, cancel: async () => { const run = await ready; await runtime.current.request(`/api/runs/${run.runId}/cancel`, { method: 'POST' }); } };
    activeRun.current = controller;
    ready.then(run => {
      historyTarget.current = run.runId; setTaskConversation(run); setRunAgentId(run.agentId); refreshRunHistory();
      addLog('任务已提交，服务端将按执行方式继续派发成员', '运行');
    }).catch(error => {
      setTask(taskGoal); setSubmittedTask(''); setTaskStartError(error.message); setToast(error.message);
      setJobs(current => Object.fromEntries(Object.entries(current).map(([id, job]) => [id, { ...job, status: 'failed', error: error.message }])));
    }).finally(() => { busy.current = false; setIsRunning(false); if (activeRun.current === controller) activeRun.current = null; });
  };
  const resolveApproval = async (approval, decision, extra = {}) => {
    const key = approvalKey(approval);
    if (approvalInFlight.current.has(key)) throw new Error('此请求正在其他位置提交，请稍候。');
    approvalInFlight.current.add(key);
    try {
      await runtime.current.respondApproval(approval.requestId, { ...extra, decision, runId: approval.runId });
      resolvedApprovals.current.add(key);
      setApprovals(current => current.filter(item => approvalKey(item) !== approvalKey(approval)));
      addLog(`${approvalTitle(approval.method)}已${decision === 'accept' ? '允许' : '拒绝'}`, decision === 'accept' ? '审批' : '停止');
    } catch (error) { throw error; } finally { approvalInFlight.current.delete(key); }
  };
  const visibleAgents = agents.filter(a => `${a.name} ${a.role} ${a.description}`.toLowerCase().includes(filter.toLowerCase()));
  const toggleListValue = (key, value) => updateAgent(key, selected[key]?.includes(value) ? selected[key].filter(item => item !== value) : [...(selected[key] || []), value]);
  const skillOptions = capabilityOptions.skills;
  const mcpOptions = capabilityOptions.mcpServers;
  const providerOptions = [...new Map([...config.providers, ...(backend.health?.providers || [])].map(provider => [provider.id, provider])).values()];
  const includedTeamIds = new Set(team.children || []);
  const activeDescendants = descendantsOf(config.activeTeamId);
  const childTeams = config.teams.filter(entry => entry.id !== config.activeTeamId && (includedTeamIds.has(entry.id) || (!activeDescendants.has(entry.id) && !descendantsOf(entry.id).has(config.activeTeamId) && !config.teams.some(parent => parent.id !== config.activeTeamId && (parent.team.children || []).includes(entry.id)))));
  const parentTeam = config.teams.find(entry => (entry.team.children || []).includes(config.activeTeamId));
  const parentIds = new Set(config.teams.flatMap(entry => entry.team.children || []));
  const rootTeams = config.teams.filter(entry => !parentIds.has(entry.id));
  const agentNameById = new Map(config.teams.flatMap(entry => entry.agents.map(agent => [agent.id, agent.name])));
  const agentTeamById = new Map(config.teams.flatMap(entry => entry.agents.map(agent => [agent.id, entry.team.name])));
  const activeAgentIds = new Set(executionAgents.map(agent => agent.id));
  const visibleMessages = messages.filter(message => activeAgentIds.has(message.fromAgentId) || (message.toAgentId && activeAgentIds.has(message.toAgentId)));
  // 高频执行快照留在当前页面的子树，不再让整个配置 Hook 随每条输出重渲染。
  const currentExecution = { error: '' };
  const currentAgents = taskConversation ? taskConversation.coordination?.members || [] : executionAgents;
  const notifications = useNotifications({ runtime, connected: backend.state === 'connected', approvals });

  return { teamSettingsTab, setTeamSettingsTab, openTeamSettings, effectiveSelected, effectiveAgents, setAgentMode, selectAllTeamCapabilities, applyTeamConfiguration, createCompany, taskStartError, currentAgents, executionSyncError: currentExecution.error, notifications, taskSandbox, setTaskSandbox, taskApprovalPolicy, setTaskApprovalPolicy, setRunHistoryFocus, historyError, taskConversation, restoreConversation, removeHistory, viewRun, runHistoryFocus, consumeRunHistoryFocus, approvalError, selectAllCapabilities, agentTeamById, newTask, submittedTask, runAgentId, setRunAgentId, refreshCatalog, catalogLoading, catalogError, config, savedConfig, warning, selectedId, sizeDraft, task, taskCwd, setTaskCwd, jobs, logs, isRunning, toast, undo, filter, backend, catalog, approvals, runHistory, messages, messageDraft, messageTo, view, interfaceDialog, interfaceDraft, exportText, exportDialog, exportField, interfaceDialogRef, runtime, activeRun, busy, fileInput, activeTeamEntry, team, agents, executionAgents, selected, dirty, refreshRunHistory, prefix, addLog, sendMessage, publishAgentMessage, openInterfaceDialog, closeInterfaceDialog, updateInterfaceDraft, commitInterfaceDraft, updateTeam, toggleTeamChild, updateAgent, switchTeam, createTeam, deleteTeam, replaceAgents, resizeTeam, addAgent, removeAgent, restoreUndo, save, exportConfig, downloadConfig, copyConfig, importConfig, dispatch, resolveApproval, visibleAgents, toggleListValue, skillOptions, mcpOptions, providerOptions, agentNameById, activeAgentIds, visibleMessages, includedTeamIds, childTeams, parentTeam, rootTeams, setConfig, setSavedConfig, setWarning, setSelectedId, setSizeDraft, setTask, setJobs, setLogs, setIsRunning, setToast, setUndo, setFilter, setBackend, setCatalog, setApprovals, setRunHistory, setMessages, setMessageDraft, setMessageTo, setView, setInterfaceDialog, setExportText };
}

