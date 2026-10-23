function App() {
  const workspace = useWorkspace();
  return <>
    <PanelShell workspace={workspace}>
      <PanelViews workspace={workspace} />
    </PanelShell>
    <DialogLayer workspace={workspace} />
  </>;
}

// file: 与恶意 sandbox iframe 都使用 null Origin，不能对它们开放本机控制接口。
function LocalServiceEntry() {
  const [error, setError] = React.useState('');
  const exportLegacy = () => {
    try {
      const content = localStorage.getItem('agent-manager:v1');
      if (!content) throw new Error('此文件页面没有已保存的团队配置。');
      JSON.parse(content);
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'team-studio-config.json'; link.click(); URL.revokeObjectURL(url); setError('');
    } catch (cause) { setError(cause.message); }
  };
  return <main style={{ maxWidth: 640, margin: '15vh auto', padding: 32 }}><h1>Team Studio</h1><p>请通过本机服务打开管理面板。直接打开 HTML 文件不再连接任务、历史和审批接口。</p><p>双击 Start.cmd 启动服务，然后打开下方地址。原来保存在此文件页面的团队配置可导出，再到管理面板导入。</p><a className="btn primary" href="http://127.0.0.1:3210">打开本机管理面板</a><button className="btn" onClick={exportLegacy}>导出此页面旧配置</button>{error && <p role="alert">{error}</p>}</main>;
}
ReactDOM.createRoot(document.getElementById('root')).render(window.location.protocol === 'file:' ? <LocalServiceEntry/> : <App/>);
