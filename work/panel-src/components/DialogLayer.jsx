/* 公共对话框：独立草稿、明确的取消行为与原生焦点约束。 */
function InterfaceDialog({ workspace }) {
  const { interfaceDialog, interfaceDraft, interfaceDialogRef, closeInterfaceDialog, commitInterfaceDraft,
    providerOptions, updateInterfaceDraft, warning } = workspace;
  if (!interfaceDialog || !interfaceDraft) return null;
  return <dialog ref={interfaceDialogRef} className="interface-dialog" aria-labelledby="interface-title" onCancel={closeInterfaceDialog}>
    <div className="dialog-top"><div><span className="eyebrow">TEAM CONNECTION</span><h3 id="interface-title">团队默认接口</h3><p>设置当前团队发起任务时使用的默认参数。</p></div><button className="icon-button" aria-label="关闭接口配置" onClick={closeInterfaceDialog}><Icon name="close"/></button></div>
    <form onSubmit={event => { event.preventDefault(); commitInterfaceDraft(); }}>
      <div className="dialog-form"><Field label="Provider"><select value={interfaceDraft.provider} onChange={e => updateInterfaceDraft('provider', e.target.value)}>{providerOptions.map(provider => <option key={provider.id} value={provider.id}>{provider.label || provider.id}</option>)}</select></Field><Field label="模型"><input maxLength="120" value={interfaceDraft.model} onChange={e => updateInterfaceDraft('model', e.target.value)} placeholder="default"/></Field><DirectoryField label="工作目录" value={interfaceDraft.cwd} onChange={value => updateInterfaceDraft('cwd', value)}/><Field label="审批策略"><select value={interfaceDraft.approvalPolicy} onChange={e => updateInterfaceDraft('approvalPolicy', e.target.value)}><option value="on-request">按需询问</option><option value="never">从不询问</option><option value="untrusted">仅不受信操作</option></select></Field>{warning && <p className="dialog-message" role="alert">{warning}</p>}</div>
      <div className="dialog-actions"><button type="button" className="btn" onClick={closeInterfaceDialog}>取消</button><button type="submit" className="btn primary">保存接口配置</button></div>
    </form>
  </dialog>;
}
function ExportDialog({ workspace }) {
  const { exportText, exportDialog, exportField, setExportText, copyConfig, downloadConfig, toast } = workspace;
  if (!exportText) return null;
  const close = () => { exportDialog.current?.close(); setExportText(''); };
  return <dialog className="export-dialog" ref={exportDialog} aria-labelledby="export-title" onCancel={close}>
    <div className="dialog-top"><div><span className="eyebrow">WORKSPACE BACKUP</span><h3 id="export-title">导出工作空间</h3><p>包含全部团队、成员和接口配置，可在其他设备导入。</p></div><button className="icon-button" aria-label="关闭导出窗口" onClick={close}><Icon name="close"/></button></div>
    <textarea ref={exportField} aria-label="配置 JSON" readOnly value={exportText}/>
    <div className="dialog-actions"><span>JSON 格式 · 不包含运行记录</span><button className="btn" onClick={copyConfig}><Icon name="copy" size={15}/>复制 JSON</button><button className="btn primary" onClick={downloadConfig}><Icon name="download" size={15}/>下载配置</button></div>
    {toast && <p className="dialog-message" role="status">{toast}</p>}
  </dialog>;
}
function DialogLayer({ workspace }) {
  const { toast, exportText, interfaceDialog } = workspace;
  return <><InterfaceDialog workspace={workspace}/><ExportDialog workspace={workspace}/>{toast && !exportText && !interfaceDialog && <div className="toast" role="status">{toast}</div>}</>;
}
