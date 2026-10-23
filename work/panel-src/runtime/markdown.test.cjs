const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderConversationMarkdown: render } = require('./markdown.js');

test('报告展示标题、强调、嵌套列表、引用、表格、代码和只读任务清单', () => {
  const html = render('## 综述\n\n**关键模块** 与 *说明*、~~旧方案~~、`work/server.cjs`。\n\n- 调度\n  - 反馈\n\n1. 构建\n2. 验证\n\n> 检查依据\n\n| 模块 | 状态 |\n| --- | ---: |\n| 调度 | 通过 |\n\n- [x] 完成\n- [ ] 待处理\n\n```js\nconst value = "<script>";\n```');
  for (const pattern of [/<h2>综述<\/h2>/, /<strong>关键模块<\/strong>/, /<em>说明<\/em>/, /<s>旧方案<\/s>/,
    /<code>work\/server.cjs<\/code>/, /<ul>[\s\S]*<ul>/, /<ol>/, /<blockquote>/, /class="markdown-table"/, /<th style="text-align:right">/,
    /type="checkbox" disabled checked/, /type="checkbox" disabled aria-label="未完成"/, /<pre><code class="language-js">const value = &quot;&lt;script&gt;&quot;/]) assert.match(html, pattern);
});

test('普通多行和流式未闭合代码可显示，补完 Markdown 后正常解析', () => {
  assert.match(render('第一行\n第二行'), /第一行<br>\n第二行/);
  assert.match(render('```js\nconst a = 1;'), /<pre><code class="language-js">const a = 1;/);
  const complete = render('```js\nconst a = 1;\n```\n\n**完成**');
  assert.match(complete, /<\/pre>\n<p><strong>完成<\/strong>/);
  assert.match(render('**尚未结束'), /尚未结束/);
  assert.equal(render(null), '');
  assert.equal(render(''), '');
});

test('原始 HTML、事件属性、恶意协议和相对接口链接不能执行或导航', () => {
  for (const input of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="https://example.com"></iframe>', '<svg onload=alert(1)>']) {
    const html = render(input);
    assert.doesNotMatch(html, /<(script|img|iframe|svg)\b/i);
    assert.match(html, /&lt;/);
  }
  for (const input of ['[运行](javascript:alert%281%29)', '[运行](jAvAsCrIpT:alert%281%29)', '[运行](jav&#x61;script:alert%281%29)', '[运行](data:text/html,test)', '[运行](vbscript:test)', '[路径](file:///C:/test.txt)', '[接口](/api/stop)', '[路径](../work/server.cjs)', '[协议](//example.com)']) {
    assert.doesNotMatch(render(input), /<(a|img)\b/i, input);
  }
  const html = render('[文档](https://example.com "说明") 与 https://example.org');
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/example.org"/);
});

test('图片仅生成用户点击的链接，代码中的 HTML 与 Markdown 保持字面内容', () => {
  const html = render('![预览](https://example.com/image.png)\n\n![本地](file:///C:/image.png)\n\n```html\n<script>alert(1)</script>\n**不是强调**\n```');
  assert.doesNotMatch(html, /<(img|script|strong)\b/i);
  assert.match(html, /href="https:\/\/example.com\/image.png"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\*\*不是强调\*\*/);
});
