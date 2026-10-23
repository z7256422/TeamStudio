/* 流式文本按当前完整消息重算；其他成员的更新不会重解析未变化的长报告。 */
const MarkdownContent = React.memo(function MarkdownContent({ text = '', className = '' }) {
  const [limit, setLimit] = React.useState(12000);
  const visible = text.slice(0, limit), deferred = React.useDeferredValue(visible);
  const html = React.useMemo(() => renderConversationMarkdown(deferred), [deferred]);
  return <><div className={`markdown-content ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }}/>{text.length > limit && <button type="button" className="text-button" onClick={() => setLimit(value => value + 12000)}>显示更多正文（已显示 {limit} / {text.length} 字符）</button>}</>;
});
