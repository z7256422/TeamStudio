const fs = require('node:fs');
const path = require('node:path');
const Babel = require('./vendor/babel.cjs');
const workspace = path.resolve(__dirname, '..');
const outputPath = path.join(workspace, 'outputs/agent-manager.html');
// 样式直接来自模块化源码，避免历史模板和覆盖样式叠加。
const styles = ['base.css', 'shell.css', 'workspaces.css', 'directory-picker.css', 'conversation.css', 'office.css', 'task-activity.css', 'execution-transcript.css', 'execution-reasoning.css', 'notifications.css', 'task-composer.css', 'interaction-sequence.css', 'custom-providers.css', 'integrations.css', 'team-settings.css', 'markdown.css'].map(file =>
  fs.readFileSync(path.join(__dirname, 'panel-src/styles', file), 'utf8')).join('\n');
// 前端开发源码按依赖顺序组织；构建时仍编译成一个离线 HTML，便于本机直接打开。
// 运行时不依赖 bundler，源码模块通过明确的全局函数/类协作，后续可以平滑迁移到 Vite 或其他 bundler。
const sourceFiles = [
  'work/panel-src/config/constants.js',
  'work/panel-src/config/capabilities.js',
  'work/panel-src/config/team-presets.js',
  'work/panel-src/config/company-roles.js',
  'work/panel-src/config/company-template.js',
  'work/panel-src/config/model.js',
  'work/panel-src/runtime/workspace-events.js',
  'work/panel-src/runtime/control-plane.js',
  'work/panel-src/runtime/team-management.js',
  'work/panel-src/runtime/conversation-model.js',
  'work/panel-src/runtime/execution-transcript.js',
  'work/panel-src/runtime/markdown.js',
  'work/panel-src/runtime/task-title.js',
  'work/panel-src/runtime/current-execution.js',
  'work/panel-src/runtime/interaction-sequence.js',
  'work/panel-src/runtime/approval-details.js',
  'work/shared/run-reasoning.js',
  'work/shared/model-reasoning.js',
  'work/shared/run-progress.js',
  'work/panel-src/office/model.js',
  'work/panel-src/state/useOffice.js',
  'work/panel-src/state/useCurrentExecution.js',
  'work/panel-src/state/useWorkspace.js',
  'work/panel-src/state/useNotifications.js',
  'work/panel-src/state/useInteractionSequence.js',
  'work/panel-src/components/Primitives.jsx',
  'work/panel-src/components/MarkdownContent.jsx',
  'work/panel-src/components/DirectoryPicker.jsx',
  'work/panel-src/components/TaskDirectoryMenu.jsx',
  'work/panel-src/components/TaskComposer.jsx',
  'work/panel-src/components/ConfirmDialog.jsx',
  'work/panel-src/office/PixelArt.jsx',
  'work/panel-src/components/RunProgress.jsx',
  'work/panel-src/components/TeamFeedback.jsx',
  'work/panel-src/components/ExecutionTranscript.jsx',
  'work/panel-src/components/ExecutionReasoning.jsx',
  'work/panel-src/components/ExecutionCard.jsx',
  'work/panel-src/components/RunHistoryReader.jsx',
  'work/panel-src/components/RunConversation.jsx',
  'work/panel-src/components/TaskConversation.jsx',
  'work/panel-src/components/InteractionSequenceDialog.jsx',
  'work/panel-src/components/ApprovalCard.jsx',
  'work/panel-src/components/ProviderDiagnostics.jsx',
  'work/panel-src/components/CustomProviders.jsx',
  'work/panel-src/components/CapabilitySettingsEditor.jsx',
  'work/panel-src/components/NotificationCenter.jsx',
  'work/panel-src/components/PanelShell.jsx',
  'work/panel-src/components/DialogLayer.jsx',
  'work/panel-src/views/TeamsView.jsx',
  'work/panel-src/views/MessagesView.jsx',
  'work/panel-src/views/NewTaskView.jsx',
  'work/panel-src/views/TeamSettingsView.jsx',
  'work/panel-src/views/AgentSettingsView.jsx',
  'work/panel-src/views/IntegrationsView.jsx',
  'work/panel-src/views/RunsView.jsx',
  'work/panel-src/views/OfficeView.jsx',
  'work/panel-src/views/PanelViews.jsx',
  'work/panel-src/App.jsx'
];
// 逐模块编译，使语法错误定位到文件，避免跨文件注释吞掉后续组件。
const compiled = sourceFiles.map(file => Babel.transform(fs.readFileSync(path.join(workspace, file), 'utf8'), {
  filename: file, presets: ['react'], comments: true, sourceType: 'script'
}).code).join('\n;\n');
const inline = script => script.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <title>Agent 协同控制台 · Team Studio</title>
  <link rel="icon" href="data:," />
  <style>${styles}</style>
</head>
<body>
  <div id="root"></div>
  <noscript>请开启浏览器 JavaScript 以使用 Agent 协同控制台。</noscript>
  <!-- React 18.3.1 / ReactDOM 18.3.1，MIT 许可；保留运行库原始版权声明。 -->
  <!-- ${fs.readFileSync(path.join(workspace, 'outputs/THIRD_PARTY_LICENSES.txt'), 'utf8')} -->
  <script>${inline(fs.readFileSync(path.join(__dirname, 'vendor/react.js'), 'utf8'))}</script>
  <script>${inline(fs.readFileSync(path.join(__dirname, 'vendor/react-dom.js'), 'utf8'))}</script>
  <script>${inline(fs.readFileSync(path.join(__dirname, 'vendor/markdown-it.js'), 'utf8'))}</script>
  <script>${inline(compiled)}</script>
</body>
</html>
`;
fs.writeFileSync(outputPath, html, 'utf8');
console.log(`Built offline HTML: ${Buffer.byteLength(html).toLocaleString()} bytes`);
