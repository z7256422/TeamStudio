/* 通用模型连接参数；沿用模式不覆盖引擎或已恢复会话的设置。 */
const MODEL_REASONING_OPTIONS = [
  { value: 'default', label: '沿用引擎 / 会话设置' },
  { value: 'low', label: '低 · low' },
  { value: 'medium', label: '中 · medium' },
  { value: 'high', label: '高 · high' },
  { value: 'xhigh', label: '超高 · xhigh' },
  { value: 'max', label: '最高 · max' },
  { value: 'minimal', label: '最低 · minimal' },
  { value: 'none', label: '关闭 · none（仅限支持的模型）' }
];
function normalizeReasoningEffort(value = 'default') {
  if (!MODEL_REASONING_OPTIONS.some(option => option.value === value)) throw Object.assign(new Error('思考强度无效，请选择接口支持的参数值'), { statusCode: 400 });
  return value;
}
function reasoningConfigurationHint(message) {
  if (typeof message !== 'string' || !/(?:reasoning|effort|思考|推理)/i.test(message) || !/(?:unsupported|not support|invalid|不支持|无效|请使用)/i.test(message)) return '';
  return '请到「接口与能力 → 自定义模型 → 配置 / 测试」选择该接口支持的思考强度，保存后可在原会话继续。';
}
if (typeof module !== 'undefined' && module.exports) module.exports = { MODEL_REASONING_OPTIONS, normalizeReasoningEffort, reasoningConfigurationHint };
