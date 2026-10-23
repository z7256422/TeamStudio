const { spawn } = require('node:child_process');

// Windows 的 Codex 由 cmd shim 启动，关闭时需要回收整棵子进程树。
function stopProvider(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform !== 'win32') { child.kill('SIGTERM'); return Promise.resolve(); }
  return new Promise(resolve => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', error => { console.error(`关闭执行引擎失败：${error.message}`); resolve(); });
    killer.once('exit', code => {
      if (code && child.exitCode === null) console.error(`关闭执行引擎返回 ${code}，请检查是否有残留进程。`);
      resolve();
    });
  });
}

function installServiceLifecycle({ server, sessions, runStore, beforeStop = () => {}, processRef = process }) {
  let stopping = false;
  processRef.once('exit', () => {
    try { runStore.close(); }
    catch (error) { console.error(`关闭运行记录存储失败：${error.message}`); processRef.exitCode = 1; }
  });
  const shutdown = async (exitCode = 0, reason = 'service-stop') => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => processRef.exit(1), 8000);
    deadline.unref();
    // SSE 会一直保持连接；主动关闭连接，确保停止入口能完成退出并同步刷盘。
    try {
      try { beforeStop(reason); runStore.flush(); }
      catch (error) { exitCode = 1; console.error(`保存中断状态失败：${error.message}`); }
      server.close(); server.closeAllConnections();
      await Promise.allSettled([...sessions.values()].map(session => stopProvider(session.client.child)));
    } finally { clearTimeout(deadline); processRef.exit(exitCode); }
  };
  const stop = () => { void shutdown(); };
  processRef.on('SIGINT', stop);
  processRef.on('SIGTERM', stop);
  // 只接受 Node 父进程的 IPC，不向浏览器或网络暴露关闭接口。
  processRef.on('message', message => { if (message?.type === 'team-studio:shutdown') void shutdown(); });
  processRef.on('disconnect', stop);
  // 未知进程异常后不能假装运行仍可靠；记录中断、刷盘并回收引擎，重启后可见通知。
  const fatal = error => { console.error(`控制平面异常退出：${error?.name || 'Error'}；任务中断状态将保存。`); void shutdown(1, 'service-error'); };
  processRef.on('uncaughtException', fatal);
  processRef.on('unhandledRejection', fatal);
  return { shutdown };
}

module.exports = { installServiceLifecycle, stopProvider };
