/* 统一 Markdown 展示层：保留原始消息，仅生成受限的 HTML，不执行消息中的 HTML。 */
const markdownParserFactory = typeof module !== 'undefined' && module.exports ? require('../../vendor/markdown-it.js') : window.markdownit;
const conversationMarkdown = markdownParserFactory({ html: false, breaks: true, linkify: true, typographer: false });

// 对话里的工程路径继续显示为文字，避免相对链接误请求本机控制接口。
function markdownLinkAllowed(href) {
  return /^(https?:\/\/|mailto:)/i.test(href) && conversationMarkdown.validateLink(href);
}
conversationMarkdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (!markdownLinkAllowed(token.attrGet('href') || '')) return '<span class="markdown-link-text">';
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
conversationMarkdown.renderer.rules.link_close = (tokens, index, options, env, renderer) => {
  // Markdown 链接不能嵌套；按最近的 link_open 决定闭合标签。
  for (let start = index - 1; start >= 0; start--) {
    if (tokens[start].type === 'link_open') return markdownLinkAllowed(tokens[start].attrGet('href') || '') ? '</a>' : '</span>';
  }
  return renderer.renderToken(tokens, index, options);
};
// 图片先显示链接，避免生成内容自动请求外部资源；只有用户点击才打开。
conversationMarkdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index], href = token.attrGet('src') || '';
  const label = conversationMarkdown.utils.escapeHtml(renderer.renderInlineAsText(token.children || [], options, env) || '查看图片');
  return markdownLinkAllowed(href) ? `<a href="${conversationMarkdown.utils.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span>${label}</span>`;
};
conversationMarkdown.renderer.rules.table_open = () => '<div class="markdown-table" role="region" aria-label="表格" tabindex="0"><table>';
conversationMarkdown.renderer.rules.table_close = () => '</table></div>';
conversationMarkdown.core.ruler.after('inline', 'readonly_tasks', state => {
  state.tokens.forEach((token, index, tokens) => {
    if (token.type !== 'inline' || tokens[index - 1]?.type !== 'paragraph_open' || tokens[index - 2]?.type !== 'list_item_open') return;
    const first = token.children?.[0], match = first?.type === 'text' && first.content.match(/^\[([ xX])\]\s+/);
    if (!match) return;
    first.content = first.content.slice(match[0].length);
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" disabled${match[1] !== ' ' ? ' checked' : ''} aria-label="${match[1] !== ' ' ? '已完成' : '未完成'}"> `;
    token.children.unshift(checkbox);
    tokens[index - 2].attrJoin('class', 'markdown-task');
  });
});
function renderConversationMarkdown(text) {
  return conversationMarkdown.render(typeof text === 'string' ? text : '');
}
if (typeof module !== 'undefined' && module.exports) module.exports = { renderConversationMarkdown };
