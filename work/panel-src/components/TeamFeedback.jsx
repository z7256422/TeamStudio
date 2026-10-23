/* 原始问答随运行保存；取消/超时是系统结果，不能显示成经理说过的话。 */
function TeamFeedback({ feedback }) {
  if (!feedback?.length) return null;
  const pending = feedback.filter(item => item.status === 'pending').length;
  const labels = { pending: '等待答复', answered: '已答复', expired: '答复超时', cancelled: '已取消' };
  return <details className="execution-feedback" aria-label="成员反馈" open={pending > 0 || undefined}>
    <summary><Icon name="chat" size={14}/><b>成员反馈</b><span>{pending ? `${pending} 条等待经理答复` : `${feedback.length} 条问答`}</span><Icon name="down" size={14}/></summary>
    {feedback.map(item => <article key={item.requestId} className={`feedback-item feedback-${item.status}`}>
      <header><strong>{item.memberName || item.memberId} → {item.managerName || '项目经理'}</strong><span className="badge">{labels[item.status] || item.status}</span></header>
      <time>提问 {displayTime(item.askedAt)}</time><MarkdownContent text={item.question}/>
      {item.context && <details><summary>成员补充背景</summary><MarkdownContent text={item.context}/></details>}
      {item.answer && <blockquote><b>{item.status === 'answered' ? `${item.managerName || '项目经理'}答复` : '系统处理结果'}</b><MarkdownContent text={item.answer}/><time>{displayTime(item.answeredAt || item.resolvedAt)}</time></blockquote>}
    </article>)}
  </details>;
}
