/* 面板共享常量。通过构建脚本按依赖顺序拼接，不依赖浏览器模块加载。 */
const PANEL_CONSTANTS = {
  STORAGE_KEY: 'agent-manager:v1',
  MAX_AGENTS: 200,
  MAX_TEAMS: 50,
  COLORS: ['#526eea', '#20a27b', '#8c63dd', '#e99542', '#df6685', '#2b9db0'],
  STATES: { idle: '待命', queued: '排队', starting: '启动中', running: '执行中', waiting: '等待审批 / 输入', retrying: '引擎重试中', reconnecting: '连接恢复中', stopping: '停止中', done: '已完成', failed: '执行失败', cancelled: '已停止' },
  STRATEGIES: { manager: '项目经理主导', parallel: '全员并行', sequential: '按成员顺序接力', current: '仅当前成员' },
  BUILTIN_PROVIDERS: [
    { id: 'codex-app-server', kind: 'codex', label: '本机 Codex app-server', status: 'available' },
    { id: 'claude-code', kind: 'cli', label: 'Claude Code', status: 'planned' },
    { id: 'gemini-cli', kind: 'cli', label: 'Gemini CLI', status: 'planned' },
    { id: 'openai-compatible', kind: 'http', label: 'OpenAI-compatible HTTP', status: 'planned' }
  ]
};
const { STORAGE_KEY, MAX_AGENTS, MAX_TEAMS, COLORS, STATES, STRATEGIES, BUILTIN_PROVIDERS } = PANEL_CONSTANTS;
