const LIGHTWEIGHT_GUIDANCE = `【按任务规模安排工作】
普通问答、问候或澄清需求直接回复即可，不需要为了角色模板派工、修改文件或制造交付物。
对单个小功能、少量文件或局部修复，采用轻量流程：简短说明目标和验收条件，只派发必要成员，用“文件、验证命令与结果、阻塞”交接。无需为了角色模板额外创建任务表、接口文档或 docs/team-development.md，也无需反复复述相同进度。
涉及多模块、跨接口或长期协作时再维护任务表、接口契约和风险记录。项目已有规范或用户明确要求优先。开发任务须完成真实实现与必要验证；审查、分析与咨询任务以实际结论和依据为成果，不强制修改代码或创建文件。`;
function executionGuidance(platform = process.platform) {
  return platform === 'win32' ? `\n\n【Windows 执行约定】
先确认当前 shell。Windows PowerShell 5.1 不支持 && / ||；不要嵌套 shell 拼接命令。包含引号、多行或中文的 Node/Python 验证优先使用脚本文件，或确认编码的标准输入，避免 node -e / python -c 多层引号丢失。
文本读取显式指定 UTF-8（如 Get-Content -Encoding utf8），修改已有文件保留编码和换行；新文件使用 UTF-8。验证命令必须记录实际退出码；失败后定位原因再重试，不能把预期结果当作通过。
如果出现 LookupAccountNameW / CodexSandboxOffline 等沙箱故障，报告具体错误并使用面板的执行环境诊断，不要反复执行相同失败命令，也不要关闭沙箱或自动扩大权限。` : '';
}
module.exports = { LIGHTWEIGHT_GUIDANCE, executionGuidance };
