# deepseek-gateway

本地多 Provider Codex 网关。它把多个 OpenAI Responses 或 Chat Completions 兼容上游接入同一个地址，每个 Provider 拥有独立 KeyPool、冷却、失败状态和统计。Codex 只配置一个 Gateway Provider，并可直接通过 `/model` 在 `Provider.model` 别名之间切换；网关同时兼容旧的 `provider--model` 请求。

```text
Codex / API client
        |
        |  http://127.0.0.1:8787
        v
gateway.mjs  -- 根据请求 model 解析 Provider.model（兼容 provider--model）
        |
        +-- DeepSeek KeyPool  -- Deepseek.v4-flash
        +-- OpenRouter KeyPool -- Openrouter.claude-sonnet
        +-- Responses / Chat Completions 兼容 Provider
```

## 运行要求

- Node.js 18 或更新版本，以及 npm；构建 shadcn 状态面板需要 Node.js 20.19+ 或 22.12+
- Python 3.10 或更新版本，用于交互式配置和 Codex 配置合并；推荐 Python 3.11+
- Codex CLI，仅在需要接入 Codex 时使用

网关使用 `quickjs-emscripten` 隔离执行额度查询脚本；React/shadcn 状态面板的依赖仍隔离在 `ui/` 目录中。`gatewayctl init` 和 `gatewayctl start` 会在 lockfile 更新或依赖缺失时自动运行 `npm ci --omit=dev`。直接运行 `node gateway.mjs` 前需先执行一次 `npm ci --omit=dev`。

## 快速开始

进入项目目录并运行配置向导：

```bash
cd deepseek-gateway
./gatewayctl init
```

首次运行会由配置脚本自动构建 shadcn 状态面板。也可以手动构建：

```bash
./build-ui.sh
```

`setup-codex.sh` 在 UI 不存在或源码更新后也会自动构建；使用 `--skip-ui` 可跳过，使用 `--build-ui` 可强制重建。

如果未构建 `ui/dist`，网关会自动使用内嵌的兼容面板。

向导会依次完成：

1. 配置监听地址、冷却、黑名单阈值、重试、超时和请求体上限。
2. 可选启用网关访问密码；引导模式监听非本机地址时必须使用至少 16 个字符的密码，未填写则自动生成。
3. 通过网关共用的配置校验器生成并安全写入 `setupPending: true` 的 v2 `keys.json`，此时不要求 Provider 或 API Key。
4. 自动安装网关运行依赖，并构建 shadcn 状态面板（可通过 `--no-ui` 跳过面板构建）。
5. 检查监听地址：已有可访问的网关则直接复用，端口空闲时默认立即启动并继续 Web 配置。
6. 在状态面板中填写首个 Provider、模型和 API Key。保存成功后会原子退出引导模式，并将它设为默认 Provider 和默认模型。
7. 在面板的“Codex 配置”页签预览和下载配置，或运行 `./gatewayctl codex` 接入 Codex CLI。

默认 `init` 不会在终端询问 Provider 或 API Key。需要纯终端流程时使用 `./gatewayctl init --cli-provider`，它会保留原有的 Provider、Key 和 Codex 配置步骤。已有完整 Provider 配置再次运行 `init` 时会被保留，不会重置为引导模式。

启动后可在面板的“Provider 管理”中添加、编辑、测试或删除其他上游，选择 Responses 或 Chat Completions 上游格式，并在“Gateway 设置”中管理监听参数、运行策略和访问令牌。手工创建的旧版 `{ upstream, keys }` 配置仍可加载，并会在首次通过面板修改时以 v2 结构原子写回。

如果向导中没有选择立即启动，运行：

```bash
./gatewayctl start --config keys.json
```

默认地址：

- 状态面板：`http://127.0.0.1:8787/`
- 健康检查：`http://127.0.0.1:8787/health`

### 面板操作

“监控面板”按 Provider 分组展示密钥池；每个 Provider 下的 Key 以卡片排列。卡片包含额度、请求数、成功数、错误数、429 次数、处理中请求、累计失败、冷却时间和最后使用时间。配置了额度查询的 Provider 会定时刷新，也可以从单张 Key 卡片立即刷新。

每张 Key 卡片底部提供以下操作：

- 启用或停用 Key。每个 Provider 至少需要保留一个已启用 Key，因此最后一个已启用 Key 的开关不可关闭。
- 测试 Key。测试会直接使用该 Key 请求上游，并在 Provider 标题右侧显示 HTTP 状态和耗时；已停用的 Key 也可以测试。
- 修改权重。权重必须大于 `0`，保存后立即参与 `inFlight / weight` 调度，无需重启。
- 删除 Key。最后一个 Key 或最后一个已启用 Key 不能删除；其他 Key 删除后立即从新请求的调度池移除，不会中断正在处理的请求。

添加单个 Key 时，进入“Provider 管理”，选择对应 Provider 的编辑按钮，在“密钥”区域添加名称、API Key、权重和启用状态后保存。名称在同一个 Provider 内必须唯一；保存成功后新 Key 会立即出现在“监控面板”中。

批量添加时，在“监控面板”对应 Provider 标题右侧选择“批量导入”。可以直接粘贴文本，也可以读取本地 `.txt` 或 `.json` 文件；文件内容只在浏览器中读取，再通过同一个脱敏管理接口提交。文本支持换行、空格、逗号和分号分隔，也支持显式名称：

```text
sk-key-1
sk-key-2
primary=sk-key-3
backup:sk-key-4
```

JSON 可以使用字符串数组，也可以为单个 Key 覆盖名称、权重、启用状态和 `alwaysTry`：

```json
[
  "sk-key-1",
  { "name": "backup", "key": "sk-key-2", "weight": 2, "alwaysTry": true }
]
```

未命名的 Key 自动使用 `imported-1`、`imported-2` 等不冲突名称。重复 Secret 会被忽略并计数；同名但 Secret 不同会返回 `409`，格式错误返回 `400`。冲突或格式错误时整个批次都不会写入。单次最多导入 500 条，文本或文件内容上限为 1 MiB。

其他面板页签：

- “Provider 管理”：添加、编辑、测试或删除 Provider，维护模型别名和独立密钥池，并设置默认 Provider 或默认模型。
- “Gateway 设置”：管理监听参数、运行策略和访问令牌。`host` 和 `port` 修改后需要重启，其余未被命令行或环境变量覆盖的设置会热生效。
- “Codex 配置”：预览并下载 Codex Provider 配置和模型目录生成物。

## 交互式配置

```bash
./gatewayctl init
```

直接回车会接受当前值。默认流程只配置 Gateway 本身，Provider 和 API Key 在网关启动后通过状态面板录入。

需要在终端中同时配置首个 Provider 和 API Key 时运行：

```bash
./gatewayctl init --cli-provider
```

再次使用 `--cli-provider` 运行向导时，可以保留现有 API Key，也可以重新录入全部 Key。

向导会先检查目标地址。检测到网关正在运行时不会直接改写离线配置，而是引导到状态面板；需要修改监听参数时，应先停止网关再运行向导。

向导具有以下安全行为：

- 网关密码在终端中隐藏输入；使用 `--cli-provider` 时，API Key 也会隐藏输入。
- 监听 `0.0.0.0` 或其他非本机地址的引导配置必须设置至少 16 个字符的 Gateway token；未提供时自动生成强随机 token。
- 旧配置会迁移为 v2，并使用与网关运行时相同的规则完成规范化和校验。
- `keys.json` 通过原子替换写入，文件权限设置为 `600`。
- 修改现有配置前，会备份到 `.gateway-backups/`。
- `keys.json` 和 `.gateway-backups/` 均已加入 `.gitignore`。
- Key 名称必须唯一，权重必须是大于零的有限数值。

自定义配置路径：

```bash
./gatewayctl init --config /path/to/keys.json
```

只生成网关配置，不接入 Codex，也不询问是否启动：

```bash
./gatewayctl init --no-codex --no-start
```

完整选项：

```text
--config PATH  指定配置文件，默认 ./keys.json
--no-codex     不询问 Codex CLI 接入
--no-start     不询问立即启动网关
--no-ui        跳过 shadcn 状态面板构建
--cli-provider 在终端中配置 Provider 和 API Key
```

旧入口 `./configure.py` 会兼容转发到 `gatewayctl init`。新脚本和自动化应直接使用 `gatewayctl`。

其他运维命令：

```bash
./gatewayctl validate --config keys.json
./gatewayctl doctor --config keys.json
./gatewayctl start --config keys.json --quiet
./gatewayctl codex --config keys.json --dry-run
```

- `validate` 使用网关配置核心完成迁移、规范化和完整校验。
- `doctor` 检查 Node.js、配置、Dashboard 构建和本地网关状态；网关未启动只会报告警告。
- `start` 和 `codex` 分别向网关进程及 Codex 配置工具转发其余参数。

## 手工配置

不使用向导时，可以复制示例文件：

```bash
cp keys.example.json keys.json
```

然后编辑 `keys.json`。v2 配置的核心结构如下，完整字段见 `keys.example.json`：

```json
{
  "schemaVersion": 2,
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek--v4-flash",
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "upstreamFormat": "responses",
      "enabled": true,
      "balanceQuery": {
        "enabled": true,
        "language": "javascript",
        "code": "({ request: { ... }, extractor: function(response) { ... } })",
        "timeoutMs": 10000,
        "refreshMs": 300000
      },
      "models": [
        {
          "id": "v4-flash",
          "name": "V4 Flash",
          "upstreamModel": "deepseek-v4-flash",
          "inputModalities": ["text"]
        }
      ],
      "keys": [
        {
          "name": "primary",
          "key": "sk-你的Key",
          "weight": 1,
          "enabled": true,
          "alwaysTry": true
        }
      ]
    }
  ]
}
```

`keys.example.json` 提供了可直接使用的 DeepSeek 额度查询脚本。DeepSeek Provider 未显式设置 `balanceQuery` 时也会使用同一内置脚本；设置 `"balanceQuery": { "enabled": false }` 可以关闭该 Provider 的查询。

## JavaScript 额度查询

在“Provider 管理”中编辑 Provider，可以启用额度查询、套用 DeepSeek 或 OpenRouter 模板、调整超时和刷新周期，并在保存前用当前草稿和指定 Key 测试。脚本需要求值为一个包含 `request` 与 `extractor(response)` 的对象，例如：

```javascript
({
  request: {
    url: "{{baseUrl}}/quota",
    method: "GET",
    headers: {
      Authorization: "Bearer {{apiKey}}",
      Accept: "application/json"
    }
  },
  extractor: function(response) {
    return {
      planName: response.plan,
      remaining: Number(response.remaining),
      used: Number(response.used),
      total: Number(response.total),
      unit: "USD",
      isValid: response.active !== false
    };
  }
})
```

执行分为两个隔离阶段：QuickJS 先计算 `request`，宿主进程再替换占位符并发送 HTTP 请求，最后使用一个全新的 QuickJS 上下文运行 `extractor`。脚本本身不会直接获得 API Key，也不能访问 Node.js、文件系统或网络 API。

`request` 支持以下内容：

- `url`：必填，可使用 `{{baseUrl}}`、`{{apiKey}}`、`{{keyName}}` 和 `{{providerId}}` 占位符。
- `method`：仅支持 `GET` 或 `POST`，默认 `GET`。
- `headers`：可选对象；`Host`、`Content-Length`、连接控制和代理相关 Header 会被拒绝。
- `body`：可选字符串或对象；`GET` 不能携带 body。

`extractor` 可以返回单个额度对象或最多 16 个对象的数组。对象可包含 `planName`、`remaining`、`used`、`total`、`unit`、`extra`、`isValid` 和 `invalidMessage`；兼容 DeepSeek 的模板还会返回 `granted` 与 `toppedUp`。有效结果至少要包含 `remaining`、`used` 或 `total` 之一。

安全限制如下：脚本最大 64 KiB，QuickJS 内存上限 8 MiB、栈上限 512 KiB，单阶段执行最多 500 ms；HTTP 超时可设置为 2 至 30 秒。请求必须与 Provider `baseUrl` 同源，只允许 HTTPS，回环地址可使用 HTTP；不跟随重定向，请求体最大 64 KiB，响应最大 1 MiB。`refreshMs` 可设为 10 秒至 24 小时，未设置时使用全局 `balanceRefreshMs`。

也可以完全使用环境变量，不创建 `keys.json`：

```bash
DEEPSEEK_KEYS="main=sk-xxx,backup=sk-yyy" node gateway.mjs
```

## 接入 Codex

推荐先在 Web UI 中完成首个 Provider 配置，再在面板的“Codex 配置”中预览和下载生成物。默认 `gatewayctl init` 在引导完成前不会生成 Codex 配置；使用 `gatewayctl init --cli-provider` 时仍可在向导中选择同步到 Codex CLI。

也可以单独运行：

```bash
./gatewayctl codex --dry-run
./gatewayctl codex
```

`setup-codex.sh` 仍可作为底层兼容入口直接运行。

模型的输入能力通过 `providers[].models[].inputModalities` 按模型配置，支持 `text` 和 `image`，且必须包含 `text`。默认值为 `["text"]`；DeepSeek 默认模型保持文本-only。只有显式配置为 `["text", "image"]` 的模型才会接受图片输入，网关会对文本-only 模型返回 400。

Provider ID 保持小写字母、数字和单连字符格式。模型 ID 另行支持模型服务常见的 `.`, `_`, `/`, `:` 和 `+` 字符，但保留 `--` 作为 Provider 与模型的内部 canonical alias 分隔符。Codex catalog 使用首字母大写的 `${providerId}.${modelId}` 作为模型 ID 和展示名称，例如内部别名 `openrouter--gpt-4.1` 在 Codex 中显示为 `Openrouter.gpt-4.1`。网关对旧的双连字符 alias 保持兼容。

脚本会备份并合并：

- `~/.codex/config.toml`
- `~/.codex/gateway-models.json`

自定义模型和网关地址：

```bash
MODEL="Deepseek.v4-pro" \
GATEWAY_URL="http://127.0.0.1:8787" \
./setup-codex.sh
```

Codex 配置会跟随 Gateway 的认证状态生成：Gateway 配置了 `token` 时才写入 `env_key`；未配置时不要求任何 Token 环境变量。无论哪种模式，上游 API Key 和 Gateway token 的内容都不会写进 Codex 配置。

启用 Gateway 认证时，启动 Codex 前设置客户端环境变量，其值必须与 Gateway 当前生效的 Token 一致：

```bash
export DEEPSEEK_GATEWAY_TOKEN="你的网关密码"
```

Gateway 服务端读取的是 `keys.json` 中的 `token`、`DS_GATEWAY_TOKEN` 或启动参数 `--token`；`DEEPSEEK_GATEWAY_TOKEN` 只供 Codex 读取，不会启用 Gateway 服务端认证。Web UI 的“Codex 配置”页会根据当前进程的实际认证状态生成正确配置。

离线运行 `gatewayctl codex` 时，`--auth auto`（默认）根据配置文件中的 `token` 判断。若 Gateway 仅通过 `DS_GATEWAY_TOKEN` 或 `--token` 启动，需要显式指定认证模式：

```bash
./gatewayctl codex --auth required
# 明确生成无认证配置：
./gatewayctl codex --auth none
```

完成后，在任意项目目录运行：

```bash
codex
```

启动信息应显示 `Deepseek.v4-flash` 或配置的 Codex 默认别名。在 Codex 内执行 `/model` 即可切换到其他 Provider 的别名；新增目录项后需要重启一次 Codex 以重新加载 `model_catalog_json`。修改模型的 `inputModalities` 后，重新运行 `./gatewayctl codex`（或在 Web UI 下载并应用最新配置），然后重启 Codex，使新的 `input_modalities` 能力目录生效。恢复最近一次 Codex 配置备份：

```bash
./setup-codex.sh --undo
```

## 调用网关

未设置网关 `token` 时：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek--v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

设置了网关 `token` 时，需要发送 Bearer token：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer 你的网关密码' \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek--v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

网关根据 `model` 精确匹配 `${providerId}--${modelId}`，选定 Provider 后把模型字段改写为 `upstreamModel`。带 `--` 但未命中的别名会返回 `400`；未带前缀的旧模型名仍由 `defaultProvider` 原样转发。响应头 `X-Gateway-Provider`、`X-Gateway-Model` 和 `X-Gateway-Key` 可用于核对路由结果。

### Chat Completions 上游

Provider 的 `upstreamFormat` 支持两个值：

- `responses`：默认值，保持原有路径、请求体和响应透传行为。
- `chat-completions`：客户端调用 `/v1/responses` 时，网关把请求转换后转发至上游 `/v1/chat/completions`，再将 JSON 或 SSE 转回 Responses 格式。客户端直接调用 `/v1/chat/completions` 时仍原样透传。

转换支持文本、输入图片、function/custom/namespace 工具、工具结果、reasoning、结构化输出、流式 usage 和缺失 `[DONE]` 时的终止事件补全。`previous_response_id`、`item_reference`、后台响应、托管 `web_search`/`file_search`/computer 工具以及 `input_file` 无法无损映射，网关会返回明确的 `400`，不会静默丢弃字段。

Codex 配置仍固定使用 `wire_api = "responses"`。上游协议只在 Provider 中选择，不需要改动 Codex 配置。

## 调度策略

每个 Provider 的 KeyPool 分别维护并发数、成功数、错误数、429 次数、累计失败数、冷却截止时间和失效状态。同名上游模型不会共享 Key、冷却或失败状态。

在面板中编辑 Provider 并添加 Key 后，新 Key 会立即加入正在运行的调度池，无需重启网关。未改变的 Key 按 secret 指纹复用原状态，因此改名或调整权重不会清空其统计、冷却、失效状态或余额；删除 Key 也不会中断已经使用它的请求。修改 Provider 的 `baseUrl` 时，新请求立即切换到新上游，旧 runtime 会等待进行中的响应（包括 SSE 长流）结束后再释放连接。

当上游为 `api.deepseek.com` 且未显式配置时，网关使用内置脚本访问 DeepSeek `/user/balance`。其他 Provider 只有在配置并启用 `balanceQuery` 后才会发起额度请求。网关启动和脚本热更新后会立即查询每个已启用 Key，随后按 Provider 的 `balanceQuery.refreshMs` 或全局 `balanceRefreshMs` 刷新。查询失败只记录在面板和 `/health` 中，不计入 Key 的业务失败次数；全局间隔设置为 `0` 会关闭没有独立刷新周期的后台查询，仍可手动刷新。

| 事件 | 处理 |
| --- | --- |
| 正常响应 | 记录成功并清除冷却状态，不清零累计失败数 |
| `429` | 优先使用 `Retry-After`，否则按 `cooldownMs` 冷却，并切换 Key 重试 |
| `5xx` / 网络错误 | 增加累计失败数；达到 `blacklistThreshold` 后标记为 `invalid`；`alwaysTry` Key 只记录异常，仍保留在调度池 |
| `401` / `402` / `403` | 立即标记为 `invalid`，永久移出当前进程的调度池；`alwaysTry` Key 只记录异常，后续请求仍会尝试 |
| 全部 Key 冷却或失效 | 返回 `502 no keys available`，不再强行调度不可用 Key |

正常情况下，调度器先排除停用、冷却和失效 Key，再选择 `inFlight / weight` 最小的 Key，平分时使用轮询游标。`inFlight` 会保持到响应体完整结束，因此长时间 SSE 请求也参与并发均衡。每个 Provider 至少需要保留一个 `enabled: true` 的 Key。

Key 设置 `"alwaysTry": true` 后，鉴权错误、网络错误或 `5xx` 不会将它自动移出调度池。失败 Key 仍会从当前请求的后续重试中排除，避免同一请求重复调用；新的请求可以再次选择它。`429` 是例外：无论是否启用 `alwaysTry`，网关都会尊重 `Retry-After` 或 `cooldownMs`。因此只有一个 `alwaysTry` Key 时，普通失败后的每个新请求仍会调用该 Key，限流冷却期间则返回 `502 no keys available`。Web UI 会将这种状态显示为“异常但继续尝试”。

每个请求最多切换 `min(maxRetries, 已启用 Key 数量 - 1)` 次。失败切换发生在向客户端写出响应头之前；流式传输开始后的上游中断会记录为该 Key 的网络错误。

## 配置参考

标量配置优先级为：命令行 > 环境变量 > `keys.json` > 默认值。`--keys`、`DEEPSEEK_KEYS` 和 `--upstream` 作为兼容入口作用于默认 Provider；旧版 `{ upstream, keys }` 配置会在内存中迁移为 `deepseek` Provider。

`gatewayctl init` 首次生成的配置带有 `setupPending: true`，并使用空 `providers`、空 `defaultProvider` 和空 `defaultModel` 表示 Web 引导尚未完成。该结构只在显式引导模式下有效，普通配置仍必须包含可用 Provider。引导期间：

- `GET /health` 返回 `setupRequired: true`，状态面板和 Settings API 保持可用。
- 代理请求返回 `503 gateway setup required`，`GET /api/codex/config` 返回 `409`。
- 首个合法 Provider 保存成功后，网关一次性写入 Provider、默认 Provider 和默认模型，并清除 `setupPending`；失败的保存不会留下部分配置。
- 完成引导后不能删除最后一个 Provider。

环境变量和命令行参数只影响本次运行，不会通过管理 API 回写到 `keys.json`。当 `--keys`、`DEEPSEEK_KEYS`、`--upstream` 或 `DS_UPSTREAM` 覆盖 Provider 配置时，Provider 管理写操作会返回 `409`；移除覆盖并重启后即可恢复写入。这可以避免运行时传入的 Key 被意外持久化。

“Gateway 设置”会显示持久化值、当前生效值和覆盖来源，认证状态以当前生效值为准。`cooldownMs`、`blacklistThreshold`、`balanceRefreshMs`、`maxRetries`、`timeoutMs`、`maxBodyBytes` 和 `token` 在没有运行时覆盖时热生效；`host` 和 `port` 保存后需要重启。被命令行或环境变量接管的字段在面板中为只读，覆盖值不会写入配置文件。通过面板设置新 Token 后，当前浏览器会自动获得新会话 Cookie；清除 Token 时会同步清除 Cookie。

| JSON 字段 | 命令行 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `setupPending` | - | - | `false` | `true` 表示等待通过 Web UI 配置首个 Provider |
| `port` | `--port` | `DS_GATEWAY_PORT` | `8787` | 监听端口 |
| `host` | `--host` | - | `127.0.0.1` | 监听地址 |
| `providers[]` | - | - | DeepSeek 兼容项 | Provider 的 `id`、`baseUrl`、`upstreamFormat`、`models`、`keys`、`balanceQuery` 和启用状态 |
| `providers[].upstreamFormat` | - | - | `responses` | 上游协议，可选 `responses` 或 `chat-completions` |
| `providers[].models[].id` | - | - | - | Codex 路由模型 ID，支持 `.`, `_`, `/`, `:`、`+` 和单连字符；不能包含保留分隔符 `--` |
| `providers[].models[].inputModalities` | - | - | `["text"]` | 模型输入能力，可选 `text`、`image`；必须包含 `text`。图片仅对显式启用 `image` 的模型放行 |
| `providers[].keys[].alwaysTry` | - | - | `false` | 鉴权或上游失败后仍允许新的请求继续调度该 Key；仍尊重 429 冷却和手动停用 |
| `defaultProvider` | - | - | 第一个启用项 | 未带别名前缀时使用的 Provider |
| `defaultModel` | - | - | 默认 Provider 首个模型 | Codex 启动模型别名 |
| `upstream` | `--upstream` | `DS_UPSTREAM` | `https://api.deepseek.com` | 旧配置/默认 Provider 上游 URL |
| `keys[]` | `--keys` | `DEEPSEEK_KEYS` | - | 旧配置/默认 Provider Key |
| `cooldownMs` | `--cooldown-ms` | `DS_COOLDOWN_MS` | `60000` | 429 冷却时间 |
| `blacklistThreshold` | `--blacklist-threshold` | `DS_BLACKLIST_THRESHOLD` | `3` | 累计失败黑名单阈值；0 表示禁用 |
| `balanceRefreshMs` | `--balance-refresh-ms` | `DS_BALANCE_REFRESH_MS` | `300000` | 未单独设置 `balanceQuery.refreshMs` 时的额度后台刷新间隔；0 表示禁用后台刷新 |
| `maxRetries` | `--max-retries` | `DS_MAX_RETRIES` | `2` | 每次请求最多切换次数 |
| `timeoutMs` | - | - | `0` | 上游超时；0 表示不限 |
| `maxBodyBytes` | `--max-body-bytes` | `DS_MAX_BODY_BYTES` | `67108864` | 请求体大小上限；超限返回 413 |
| `token` | `--token` | `DS_GATEWAY_TOKEN` | 空 | 网关访问密码 |

旧配置中的 `breakerThreshold`、命令行参数 `--breaker` 和环境变量 `DS_BREAKER` 仍可使用，并按相同优先级映射到累计失败黑名单阈值。

指定其他配置文件：

```bash
node gateway.mjs --config /path/to/keys.json
```

也可以设置 `DS_GATEWAY_CONFIG`。

## 面板与鉴权

- 状态面板使用 React、Vite 和 shadcn/ui；生产构建位于 `ui/dist`。
- `GET /`：状态面板，每 2 秒刷新一次。
- `GET /health`：JSON 健康状态，适合脚本和监控。
- `GET/POST /api/providers`：读取脱敏配置或添加 Provider。
- `PATCH/DELETE /api/providers/:id`：修改或删除 Provider。
- `PATCH/DELETE /api/providers/:id/keys/:name`：热更新 Key 的启用状态或权重，或删除 Key。
- `POST /api/providers/:id/keys/import`：批量解析、去重并原子导入 Key；响应只返回新增数、忽略数和脱敏元数据。
- `POST /api/providers/:id/keys/:name/test`：使用指定 Key 测试上游连接，包括已停用 Key。
- `POST /api/providers/:id/keys/:name/balance`：立即刷新指定 Key 的额度并返回新的 Key 状态。
- `GET/PATCH /api/settings`：读取或修改脱敏的 Gateway 标量设置；响应只返回 `tokenConfigured`，不会返回令牌内容。
- `POST /api/models`：通过 Provider 的 Base URL 和 Key 获取上游模型列表；支持 `/v1/models`、`/models` 及兼容子路径回退，不会自动写入配置。
- `POST /api/balance/test`：测试尚未保存的 `balanceQuery` 草稿；不会修改 Provider 配置。
- `POST /api/providers/:id/test`：测试 Provider 连接。
- `GET /api/codex/config`：生成统一 Codex Provider 和模型目录。
- `GET /login`：输入网关 `token`，签发 24 小时 HttpOnly、SameSite Cookie。
- `GET /logout`：清除面板会话。

启用 `token` 后：

- 代理 API 必须使用 `Authorization: Bearer <token>`。
- 浏览器通过 `/login` 登录后可以访问面板、`/health` 和管理 API；写操作同时校验同源。
- 面板 Cookie 不能调用代理 API。
- 页面和健康接口不会返回 API Key 内容。

默认只监听 `127.0.0.1`。如果改为 `0.0.0.0` 或其他外部地址，应启用强随机 token，并通过可信反向代理提供 TLS。

## 测试

运行完整测试：

```bash
npm ci
node --test test/balance-script.mjs test/config-core.mjs test/gatewayctl.mjs test/key-import.mjs test/smoke.mjs
python3 -m unittest test/configure_test.py
npm run lint --prefix ui
npm run build --prefix ui
```

测试使用内置 mock 上游，不消耗真实 API Key。Key 后缀可触发不同 mock 行为：

| 后缀 | 行为 |
| --- | --- |
| `-ok` | 正常响应 |
| `-429` | 返回 429 |
| `-500` | 返回 500 |
| `-401` | 返回 401 |
| `-slow` | 延迟响应 |
| `-drip` | 分段流式响应 |
| `-abort` | 流式传输中断 |

测试覆盖轮询与并发调度、Provider 别名隔离、独立冷却、运行时增量 Key、批量解析与原子导入、重复 secret 拒绝、上游模型发现与 ID 归一化、Responses 与 Chat Completions 双向转换、工具调用和分片 SSE 终止事件、切换上游时的请求排空、QuickJS 额度脚本隔离与请求限制、自动和手动额度刷新、429 切换、401/402 永久剔除、5xx 累计失败黑名单、SSE 透传、流式生命周期、Provider 与 Settings API 脱敏、热更新和原子持久化、Web-first 引导、Codex 动态目录、token/Cookie 权限隔离、请求体上限、`gatewayctl`、交互式配置和备份恢复。
