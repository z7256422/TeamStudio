# 离线前端依赖

前端依赖由 `work/build-panel.cjs` 内联进离线 HTML；启动面板不需要访问 CDN。React / ReactDOM 18.3.1 和 Babel 沿用已有构建配置。

## Markdown

- `markdown-it.js`：markdown-it 15.0.2 的浏览器 UMD 构建，原文件 `package/dist/browser/markdown-it.umd.min.js`。
- 来源：https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.2.tgz
- 下载包 SHA-512（npm integrity）：`sha512-q4IGxMv56jCqT4OCRCADBoDP3LO4MhmTXjFbphHPXs4g3j9Xg5RDnxqN8IF/3vIWEU+VCnUq+7JUg/cfy2E6Qw==`
- 保存的 JS SHA-256：`635972b985228e8af9f0143647c68616b7a3bb09f6946e7e4a52e43dcf5e7be5`
- MIT 许可及浏览器包内依赖（entities、linkify-it、mdurl、punycode.js、uc.micro）的许可原文收录在 `outputs/THIRD_PARTY_LICENSES.txt`，随 HTML 和便携包一起分发。

渲染策略在 `panel-src/runtime/markdown.js`：关闭原始 HTML；链接仅开放 HTTP、HTTPS、mailto；图片转换成手动打开的链接。升级库时需重新验证流式文本、表格、嵌套列表和不可信输入。
