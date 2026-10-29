# 第三方来源与许可

| 部分 | 来源 / 许可 | 分发说明 |
| --- | --- | --- |
| 独立插件、工作台与后台代码 | 本仓库，MIT | 见根 LICENSE |
| PDF 翻译服务及适配代码 | zotero-pdf2zh，AGPL-3.0-or-later | `runtime/engine`、`runtime/pdf-engine-host.py`；保留对应许可证和可修改源码 |
| PDF 解析与翻译依赖 | PDFMathTranslate Next、BabelDOC 及 Python 依赖 | 由锁定 requirements 安装，各自许可适用 |
| KaTeX | MIT | `ui/vendor/katex/LICENSE` |
| Node.js | Node.js 与所含组件许可 | 二进制包保留 node-LICENSE |
| Codex CLI | Apache-2.0 与所含组件许可 | 包内保留官方 vendor 树与许可 |
| uv | MIT / Apache-2.0 | 二进制包保留双许可 |
| ripgrep 等 Codex 附带组件 | MIT / Unlicense 等 | 保留官方相应许可 |

源项目：[zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh)。工作流灵感：[TomBener/zotagent](https://github.com/TomBener/zotagent)。本项目不声称拥有上游代码、商标或服务。

不要删除许可证，也不要将混合分发包整体标注为纯 MIT。修改和再分发 AGPL 部分时应遵守其对应源码等要求。服务商 API 条款和费用不由开源代码许可替代。
