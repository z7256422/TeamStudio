/* 只整理审批涉及的事务，不把 reason 当成完整权限范围。 */
function approvalFileChanges(approval) {
  const changes = approval.params?.changes || approval.params?.fileChanges;
  return Array.isArray(changes) ? changes : [];
}
function approvalDetails(approval) {
  const p = approval.params || {}, fields = [];
  const show = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const add = (label, value) => { if (value != null && value !== '') fields.push([label, show(value)]); };
  add('申请原因', p.reason || p.message);
  add('执行命令', p.command || p.commandLine);
  add('工作目录', p.cwd || approval.cwd);
  add('文件变更范围', p.grantRoot);
  if (approval.method === 'item/fileChange/requestApproval' && !approvalFileChanges(approval).length) add('文件变更明细', '引擎尚未提供可关联的文件路径和差异，请确认范围后再批准；也可拒绝并让成员补充。');
  const permissions = p.permissions || p.additionalPermissions;
  if (permissions) {
    const fileSystem = permissions.fileSystem;
    add('额外读取路径', fileSystem?.read?.join('\n'));
    add('额外写入路径', fileSystem?.write?.join('\n'));
    add('文件访问范围', fileSystem?.entries?.map(entry => `${({ read: '读取', write: '写入', deny: '禁止' })[entry.access] || entry.access || '访问'}：${show(entry.path)}`).join('\n'));
    if (permissions.network?.enabled != null) add('额外网络权限', permissions.network.enabled ? '允许访问网络' : '不申请网络访问');
    // 保留完整权限定义以覆盖供应商新增字段，不仅展示部分可识别路径。
    add('完整权限范围', permissions);
  }
  add('网络访问', p.networkApprovalContext);
  add('服务', p.serverName || p.server);
  add('授权规则提议', p.proposedExecpolicyAmendment || p.proposedNetworkPolicyAmendments);
  add('任务', approval.context?.taskTitle);
  add('本次分工', approval.context?.assignment);
  if (!fields.length && approval.method !== 'item/tool/requestUserInput') fields.push(['事务说明', '引擎未提供具体命令或权限范围，可拒绝请求并让成员补充。']);
  return fields;
}
