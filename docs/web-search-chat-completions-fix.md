# Chat Completions 上游的 `web_search` 兼容问题

## 实施状态

已于 2026-08-11 实施：

- 模型能力字段使用 `supportsHostedWebSearch`，缺失时默认关闭。
- Chat Completions Provider 禁止启用该能力。
- Codex catalog 默认删除 `web_search_tool_type`，仅为显式启用能力的 Responses 模型恢复。
- Web UI 切换到 Chat Completions 时自动清除该能力。
- 适配器按 cc-switch ProxyChat 的方式过滤发送到 Chat Completions Provider 的 `web_search`，并清理失去工具后的选择字段。

## 问题现象

使用 Codex 通过网关访问某个 `chat-completions` Provider 时，收到错误：

```json
{
  "error": {
    "message": "Responses tool type web_search is not supported by Chat Completions upstreams",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_request_error"
  }
}
```

该错误通常发生在 Codex 调用 `/v1/responses`，并自动携带：

```json
{
  "tools": [
    { "type": "web_search" }
  ]
}
```

## 结论

这是协议能力不匹配，不是模型别名、图片输入或 KeyPool 路由问题。

`web_search` 是 Responses API 的托管工具。Chat Completions 通常只支持函数工具，不能把 Responses 的托管搜索工具直接转换成 Chat Completions 工具。

Chat Completions 没有可通用映射的 hosted web search。本地 ProxyChat 中转按 cc-switch 的兼容策略过滤该声明，让模型继续处理请求；这不会在网关内执行网页搜索。需要真实 hosted web search 时必须选择显式支持该能力的 Responses 模型。

## 请求链路

```text
Codex /v1/responses
  -> tools: [{ type: "web_search" }]
  -> Provider.upstreamFormat === "chat-completions"
  -> responsesRequestToChatCompletions()
  -> createToolContext()
  -> 过滤 hosted web_search
  -> 无其他工具时删除 tool_choice / parallel_tool_calls
  -> 转发 Chat Completions 上游
```

关键代码位置：

- [gateway.mjs](../gateway.mjs#L1014)：对 `chat-completions` Provider 启用 Responses 到 Chat Completions 的转换。
- [chat-completions-adapter.mjs](../chat-completions-adapter.mjs#L59)：解析 Responses 工具。
- [chat-completions-adapter.mjs](../chat-completions-adapter.mjs#L64)：构造可转换工具上下文并过滤 hosted web search。
- [codex-config.mjs](../codex-config.mjs#L82)：从 catalog 模板复制模型能力字段。
- [codex-models.json](../codex-models.json#L9)：模板包含 `web_search_tool_type: "text"`。

## 根因分析

### 1. Chat Completions 适配器不支持托管搜索

`createToolContext()` 目前支持以下类型：

- `function`
- `custom`
- `namespace`
- `tool_search`

对于 `web_search`、`web_search_preview` 和 `web_search_preview_2025_03_11` 会直接跳过；其他未知类型仍执行：

```js
throw adapterError(
  `Responses tool type ${type} is not supported by Chat Completions upstreams`,
);
```

因此 `web_search` 声明不会到达 Chat Completions 上游，也不会再导致 400；其他 function/custom 工具仍正常转换。

### 2. 只修改 Codex catalog 不能阻止 `web_search`

catalog 模型基于 `codex-models.json` 模板复制。模板中存在：

```json
"web_search_tool_type": "text"
```

按 Provider/model 能力过滤该字段仍有必要，避免目录主动宣传不兼容能力；但这不是请求时的可靠开关。当前 Codex 即使读到不含 `web_search_tool_type` 的目录项，也可能从自身默认配置恢复 Web Search，并为 Responses 请求构造 `web_search`。因此修复必须落在本地 ProxyChat 转换器，不能只依赖 catalog。

### 3. `supports_search_tool` 不是 `web_search`

当前 catalog 统一设置：

```json
"supports_search_tool": false
```

这个字段控制 Codex 的动态工具搜索/MCP 工具暴露，不等于关闭 Hosted Web Search。它不能解决 `web_search_tool_type` 仍被暴露的问题。

## 推荐修复方案

采用“请求时 ProxyChat 过滤 + 显式模型能力声明 + catalog 过滤”的方案。请求时过滤是保证 Chat Completions 上游兼容的必要措施，catalog 过滤只负责准确描述能力。

### 1. 为模型增加 Hosted Web Search 能力字段

模型配置增加可选字段：

```json
{
  "id": "gpt-4.1",
  "name": "GPT 4.1",
  "upstreamModel": "gpt-4.1",
  "inputModalities": ["text", "image"],
  "supportsHostedWebSearch": false
}
```

兼容规则：

- 字段缺失时默认 `false`。
- 只有明确配置 `true` 的模型才向 Codex 暴露 Hosted Web Search。
- `upstreamFormat: "chat-completions"` 的 Provider 不允许启用该能力。

建议在配置归一化阶段校验非法组合，并给出明确错误，而不是等请求运行时失败。

### 2. 生成 catalog 时按能力过滤

生成每个模型的 catalog 项时，先删除模板中的 Hosted Web Search 字段：

```js
const catalogModel = structuredClone(template);
delete catalogModel.web_search_tool_type;
```

只有同时满足以下条件时才恢复该字段：

```js
provider.upstreamFormat === 'responses'
  && model.supportsHostedWebSearch === true
```

示意代码：

```js
if (provider.upstreamFormat === 'responses' && model.supportsHostedWebSearch) {
  catalogModel.web_search_tool_type = template.web_search_tool_type || 'text';
}
```

这样 Chat Completions 模型不会向 Codex 主动宣传不可用的 Hosted Web Search。不过 Codex 仍可能根据运行时默认配置发送 `web_search`，所以还必须执行下一节的本地过滤。

### 3. 使用 ProxyChat 本地过滤

`responsesRequestToChatCompletions()` 按 cc-switch 的工具上下文构建逻辑忽略 hosted web search。若过滤后没有其他工具，同时删除 `tool_choice` 和 `parallel_tool_calls`，避免严格 Chat Completions 上游拒绝无工具的选择字段。

如果某个 Chat Completions 厂商提供专用搜索参数，应单独实现 Provider-specific 转换，不能把 Responses 的 `web_search` 通用伪装成普通函数工具。

### 4. 为 UI 和类型定义增加开关

如果通过 Web UI 管理模型，需要同步更新：

- 模型配置类型定义
- Provider 模型编辑表单
- Chat Completions Provider 下禁用 `supportsHostedWebSearch`
- 从 Responses 切换为 Chat Completions 时自动清除所有模型的该能力
- 配置预览和保存逻辑

## 测试计划

需要覆盖以下场景：

1. 缺少 `supportsHostedWebSearch` 时归一化为 `false`。
2. Chat Completions 模型的 catalog 不包含 `web_search_tool_type`。
3. Responses 模型显式启用 `supportsHostedWebSearch` 时保留 `web_search_tool_type`。
4. 直接向 Chat Completions Provider 发送 `web_search` 时正常转发，且上游请求不含 hosted tool。
5. 普通 `function`、`custom`、图片输入和工具调用不受影响。
6. 重新生成 Codex 配置后，生成的 `gateway-models.json` 与 `config.toml` 保持一致。

## 部署步骤

实现完成后：

```bash
./gatewayctl codex
```

重新生成 Codex 模型目录，并重启 Codex 使其重新加载 `model_catalog_json`。

如果网关进程本身也更新了代码，需要同时重启网关进程。检查 Provider 协议配置：

```bash
curl -s http://127.0.0.1:8787/health \
  | jq '.providers[] | {id, upstreamFormat, enabled}'
```

只有确认上游真实支持 Responses API 和 Hosted Web Search 时，才应把 `supportsHostedWebSearch` 设置为 `true`。

## 临时规避方式

在修复 catalog 前，可以暂时：

- 对 Chat Completions Provider 使用不携带 `web_search` 的 Codex 模型目录。
- 使用普通 `function`/`custom` 搜索工具，并由客户端或外部服务执行搜索。
- 如果上游确实支持 Responses API，将 Provider 的 `upstreamFormat` 配置为 `responses`，但不能仅凭接口路径猜测其能力。
