# 第三方对照

资源库的产品行为对照 Magpie，提交 `c3b0484a96ef4bc3cdb43cc53f68f56c996933e7`。

- 仓库：https://github.com/yetone/magpie
- 许可：MIT
- 对照模块：`internal/library` 的资源库、已有技能、导入和同步；页面分区对照 `internal/gui/assets/plugins/library/client.js`

Buddy 这一轮的 TypeScript 是自己写的，没有复制 Magpie 的 Go 或前端源码，也没有接入它的模型网关。后面的导入、链接和副本同步仍以该提交的行为为对照。


## Agent 品牌图标

按用户要求，资源库 Agent 按钮和按 Agent 面板直接复用同一 Magpie 提交的品牌图标：`claudecode-color.svg`、`codex-color.svg`、`cursor.svg`、`antigravity-color.svg`、`opencode.svg`、`kimi.svg`、`deepseek-color.svg`。文件保存在 `src/renderer/assets/agents/`，未改动图形。WeCode 变体复用同族图标并保留 W 标记；DeepSeek Harness 使用 DeepSeek 品牌图标。

这批品牌资源为用户明确要求的图标规范例外；通用操作图标继续使用 lucide-react。原始资源包含 LobeHub Icons 标识，MIT 许可及版权声明保存在 `src/renderer/public/licenses/agent-icons.txt`，随 renderer 构建复制到产物。未增加图标库依赖。
