function useCurrentExecution({ runtime, connected, conversation, setJobs }) {
  const [state, setState] = React.useState({ members: [], error: '', runId: null, ready: false });
  const runId = conversation?.runId;
  React.useEffect(() => {
    if (!runId || !connected) return;
    return watchCurrentExecution({ runId, watchResource: (...args) => runtime.current.watchResource(...args),
      onData: data => { setJobs(executionJobs(data)); setState({ runId, members: data.members, error: '', ready: true }); },
      onError: error => setState(current => current.runId === runId ? { ...current, error } : { members: [], runId, error, ready: false }) });
  }, [runId, connected]);
  return state.runId === runId ? state : { members: [], error: '', runId, ready: false };
}
