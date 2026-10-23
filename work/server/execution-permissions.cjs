/* 会话与轮次使用不同的 Codex 字段；统一转换，避免成员派发重新启用沙箱。 */
const DEFAULT_SANDBOX = 'danger-full-access';
const POLICY_TYPES = { 'danger-full-access': 'dangerFullAccess', 'workspace-write': 'workspaceWrite', 'read-only': 'readOnly' };

function sandboxPolicy(sandbox, cwd) {
  if (!Object.hasOwn(POLICY_TYPES, sandbox)) throw new Error('sandbox must be danger-full-access, workspace-write or read-only');
  return sandbox === 'workspace-write'
    ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false }
    : { type: POLICY_TYPES[sandbox] };
}

function executionPermissions(input, cwd, preserveMissing = false) {
  // 旧会话缺少快照时让 Codex 保留原权限，不能因应用默认值变化扩大历史权限。
  if (preserveMissing && input.sandbox == null && input.sandboxPolicy == null) return {};
  const fromPolicy = Object.keys(POLICY_TYPES).find(mode => POLICY_TYPES[mode] === input.sandboxPolicy?.type);
  const sandbox = input.sandbox ?? fromPolicy ?? DEFAULT_SANDBOX;
  const policy = sandboxPolicy(sandbox, cwd);
  if (input.sandboxPolicy != null && input.sandboxPolicy.type !== policy.type) {
    throw new Error('sandboxPolicy must match sandbox');
  }
  // 受管团队的工作区范围由该次任务目录生成；独立会话保留调用方明确给出的策略。
  return { sandbox, sandboxPolicy: input.management ? policy : input.sandboxPolicy || policy };
}

module.exports = { DEFAULT_SANDBOX, sandboxPolicy, executionPermissions };
