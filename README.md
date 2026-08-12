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

在另一个终端中可以优雅停止由 `gatewayctl` 或配置向导启动的实例：

```bash
./gatewayctl stop --config keys.json
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
- “模型 / 子代理 / 日志与调试 / 用量 / 存储 / 集成”：查看模型统计，管理 Codex 原生 agent 配置和 HTTP 集成，查询运行日志、30 天用量及配置备份。日志支持后端 cursor 分页、级别/Provider/模型/状态码/关键字筛选和详情查看；用量页提供 Recharts 趋势图及 Provider/模型汇总。日志和用量可手动刷新或按 5/15/30 秒自动刷新，打开编辑草稿或日志详情时会暂停自动刷新。请求失败时编辑草稿会保留，可直接重试。

### 运维数据与备份

网关在配置文件同目录维护 `gateway-operations.json`，存储日志、每日用量、集成和 Codex agent 定义。文件包含独立 schema 版本，使用进程间锁和原子替换写入，权限为 `600`；旧的无版本格式和早期伪子代理记录会自动迁移。JSON 损坏时原文件会重命名为 `gateway-operations.json.corrupt-<时间>` 后从空状态恢复，并在标准错误和运行日志中留下诊断信息。

- 日志保留 7 天且最多 5000 条，用量按日保留 30 天。
- 配置备份位于配置文件同目录，名称为 `keys.json.backup-<时间>`，最多保留 5 个。
- 恢复备份前会先备份当前配置；恢复会热更新 Provider 和可热更新设置。`host`、`port` 等监听设置仍需重启才能生效。
- 多个网关实例共享同一配置目录时，日志和用量写入会在锁内合并；生产部署仍建议每个配置文件只运行一个实例。

### Codex 原生子代理

“子代理”页管理 Codex 原生 custom agent。启用项会原子投影为 `$CODEX_HOME/agents/<name>.toml`（默认 `~/.codex/agents`），其中包含官方要求的 `name`、`description`、`developer_instructions`，以及目标 Provider 模型的 Codex 点号别名。Codex 自己创建独立 agent thread，负责工具调用、上下文、等待、追问和结果汇总；网关只透明转发这些线程发出的普通模型请求，不注入角色提示词，也不生成 `agent--<id>` 伪模型。

同名但不受网关管理的 agent 文件会在首次接管时备份到 `$CODEX_HOME/backup-gateway/agents/`，停用或删除后恢复。受管理文件被外部修改时，管理 API 返回 `409`，不会静默覆盖。目标 Provider 暂时不可用时 agent TOML 会撤下并显示 `unavailable`，目标恢复后重新投影。

例如创建 `code_reviewer` 后，在 Codex 中输入：`让 code_reviewer 检查当前改动，并在完成后汇总风险。` 真实子会话由 Codex 创建，不是一次特殊模型请求。

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
./gatewayctl stop --config keys.json
./gatewayctl codex --config keys.json --dry-run
```

- `validate` 使用网关配置核心完成迁移、规范化和完整校验。
- `doctor` 检查 Node.js、配置、Dashboard 构建和本地网关状态；网关未启动只会报告警告。
- `start` 在前台运行网关，并在当前用户的私有运行目录中登记 PID、实际监听地址和随机实例标识。一个配置文件只能对应一个受托管实例。
- `stop` 先通过带认证的 `/health` 校验运行记录中的实例标识，再发送 `SIGTERM` 并等待请求排空；重复停止会成功返回，身份不匹配时不会发送信号，也不会自动使用 `SIGKILL`。
- `codex` 向 Codex 配置工具转发其余参数。

运行记录位于 `$XDG_RUNTIME_DIR/deepseek-gateway/`；没有设置 `XDG_RUNTIME_DIR` 时使用当前用户专属的临时目录。直接执行 `node gateway.mjs` 属于非托管启动，不会被 `gatewayctl stop` 停止。若 `start` 使用了仅存在于命令行的 `--token` 覆盖，停止时需要传入相同的 `--token`，或者设置 `DS_GATEWAY_TOKEN`。

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
      "supportsEncryptedAgentMessages": false,
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
          "inputModalities": ["text"],
          "supportsHostedWebSearch": false
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

模型的 `reasoning` 能力会写入 Codex 模型目录。`levels` 决定 Codex 可选的思考强度，`default` 决定默认值。Responses 上游使用标准的 `reasoning.effort`；Chat Completions 上游使用 `parameter` 指定的字段，默认是 `reasoning_effort`。如果上游使用 `enable_thinking` 或 `thinking_budget`，可在 level 中增加 `upstreamValue` 映射，例如：

```json
{
  "parameter": "thinking_budget",
  "default": "high",
  "levels": [
    { "effort": "low", "upstreamValue": 1024 },
    { "effort": "high", "upstreamValue": 8192 }
  ]
}
```

未配置 `reasoning` 的模型不会主动发送思考参数；只有确认上游真实支持对应字段和值时才应启用。修改后重新运行 `./gatewayctl codex` 并重启 Codex，使模型目录生效。

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

模型能力集中维护在 `model-capabilities.json`。创建或获取模型时会按“上游返回的能力字段 > 精确模型名单 > 未知模型默认值”的顺序推断 `inputModalities`；显式填写 `providers[].models[].inputModalities` 时始终以配置为准。名单使用精确、大小写不敏感的模型 ID，支持命名空间尾部匹配，不会让 `deepseek-v4-pro-vision` 之类的新后缀错误继承纯文本能力。已确认的纯文本模型使用 `["text"]`，未知模型默认 `["text", "image"]`，避免客户端在能力确认前拦截未来的视觉模型。网关仍会对最终配置为文本-only 的模型拒绝图片输入。

Web UI 的模型发现列表和 Provider 模型列表会显示“图像输入”或“仅文本”；手动填写上游模型 ID 时也会自动套用目录能力。`GET /v1/models` 的每一项包含 OpenAI 兼容扩展字段 `input_modalities`，管理端可通过 `GET /api/model-capabilities` 读取完整能力目录。修改能力目录后需重启网关；已保存模型上的显式 `inputModalities` 不会被目录更新覆盖。

Responses Provider 的模型可以通过 `supportsHostedWebSearch: true` 显式向 Codex 暴露 Responses `web_search` 托管工具。该能力默认关闭；`chat-completions` Provider 不允许启用。切换 Provider 协议为 Chat Completions 时，Web UI 会自动清除模型上的 Hosted Web Search 能力。修改后需要重新运行 `./gatewayctl codex` 并重启 Codex，使新的模型目录生效。

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

`token` 仅用于推理代理。启用它时还必须配置一个不同的、至少 16 个字符的 `adminToken`（或 `DS_GATEWAY_ADMIN_TOKEN`），用于控制台登录和 `/api/*` 管理接口。旧配置如果只有 `token`，升级后会拒绝启动；先生成独立管理令牌并写入 `adminToken`，不要把管理令牌交给 Codex 或其他推理客户端。

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

转换支持文本、输入图片、function/custom/namespace 工具、工具结果、reasoning、结构化输出、流式 usage 和缺失 `[DONE]` 时的终止事件补全。与 cc-switch 的 ProxyChat 路径一致，Responses 的 `web_search` hosted tool 会在本地转换时过滤，并在没有其他可转换工具时同步删除 `tool_choice` 和 `parallel_tool_calls`，避免 Chat Completions 上游返回协议错误；这只是兼容过滤，不会在本地执行网页搜索。`previous_response_id`、`item_reference`、后台响应、`file_search`/computer 工具以及 `input_file` 无法无损映射，网关仍返回明确的 `400`。

### Multi-agent 子代理消息

Codex MultiAgentV2 通过自定义 Provider 派发子代理时，会把任务放在 `agent_message.content[].encrypted_content`。未经转换时，兼容层可能返回 `Responses content type encrypted_content is not supported by Chat Completions upstreams`，或者原生 Responses 上游返回未知 `encrypted_content` 类型。

网关默认只在 `agent_message` 内将该项改写为 `input_text`，并把外层改写成 `message(role=user)`；这既适用于原生 Responses Provider，也适用于 Responses 到 Chat Completions 的本地转换。普通 message 内容和 reasoning item 的 `encrypted_content` 不会被全局改写。只有上游原生支持 OpenAI Responses Multi-agent 加密消息时，才应设置 `supportsEncryptedAgentMessages: true` 关闭兼容解包并原样透传。Chat Completions Provider 不允许开启该能力，Web UI 切换协议时也会自动关闭它。

生成 Codex 模型目录时会按上游格式选择工具 profile。`chat-completions` 使用 ProxyChat profile，保留 Codex 的 freeform `apply_patch`，由本地网关把 Responses 请求和可转换工具调用转换成 Chat Completions，并过滤 hosted web search；`responses` 使用 NativeResponses profile，删除 `apply_patch_tool_type`、`model_messages` 和自定义 `tools`，并通过 `shell_type = "shell_command"` 提供编辑能力，避免向原生 Responses 上游发送不兼容的 custom 工具。

两个 profile 默认都不包含 `web_search_tool_type`；只有 Responses 模型配置 `supportsHostedWebSearch: true` 时才会按模型模板显式恢复。该目录字段只描述能力，Codex 仍可能从运行时默认配置生成 `web_search`，因此 Chat Completions 路径始终以请求时过滤为最终保障。Codex 配置固定使用 `wire_api = "responses"` 并请求本地网关，上游协议只在 Provider 路由中选择，不需要也不应按上游格式改动 Codex Provider。

## 调度策略

每个 Provider 的 KeyPool 分别维护并发数、成功数、错误数、429 次数、累计失败数、冷却截止时间和失效状态。同名上游模型不会共享 Key、冷却或失败状态。

在面板中编辑 Provider 并添加 Key 后，新 Key 会立即加入正在运行的调度池，无需重启网关。未改变的 Key 按 secret 指纹复用原状态，因此改名或调整权重不会清空其统计、冷却、失效状态或余额；删除 Key 也不会中断已经使用它的请求。修改 Provider 的 `baseUrl` 时，新请求立即切换到新上游，旧 runtime 会等待进行中的响应（包括 SSE 长流）结束后再释放连接。

当上游为 `api.deepseek.com` 且未显式配置时，网关使用内置脚本访问 DeepSeek `/user/balance`。其他 Provider 只有在配置并启用 `balanceQuery` 后才会发起额度请求。网关启动和脚本热更新后会立即查询每个已启用 Key，随后按 Provider 的 `balanceQuery.refreshMs` 或全局 `balanceRefreshMs` 刷新。查询失败只记录在面板和 `/health` 中，不计入 Key 的业务失败次数；全局间隔设置为 `0` 会关闭没有独立刷新周期的后台查询，仍可手动刷新。

| 事件 | 处理 |
| --- | --- |
| 正常响应 | 记录成功并清除冷却状态，不清零累计失败数 |
| `429` | 优先使用 `Retry-After`，否则按 `cooldownMs` 冷却，并切换 Key 重试 |
| `5xx` / 网络错误 | 增加累计失败数；达到 `blacklistThreshold` 后标记为 `invalid`；`alwaysTry` Key 只记录异常，仍保留在调度池 |
| `401` / `402` | 立即标记为 `invalid`，永久移出当前进程的调度池；`alwaysTry` Key 只记录异常，后续请求仍会尝试 |
| `403` | 作为当前请求的权限错误直接返回；不切换 Key，也不污染 Key 健康状态 |
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

“Gateway 设置”会显示持久化值、当前生效值和覆盖来源，认证状态以当前生效值为准。`cooldownMs`、`blacklistThreshold`、`balanceRefreshMs`、`maxRetries`、`timeoutMs`、`maxBodyBytes`、`token` 和 `adminToken` 在没有运行时覆盖时热生效；`host` 和 `port` 保存后需要重启。被命令行或环境变量接管的字段在面板中为只读，覆盖值不会写入配置文件。管理令牌变更后当前浏览器会自动获得新会话 Cookie。

| JSON 字段 | 命令行 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `setupPending` | - | - | `false` | `true` 表示等待通过 Web UI 配置首个 Provider |
| `port` | `--port` | `DS_GATEWAY_PORT` | `8787` | 监听端口 |
| `host` | `--host` | - | `127.0.0.1` | 监听地址 |
| `providers[]` | - | - | DeepSeek 兼容项 | Provider 的 `id`、`baseUrl`、`upstreamFormat`、代理消息能力、`models`、`keys`、`balanceQuery` 和启用状态 |
| `providers[].upstreamFormat` | - | - | `responses` | 上游协议，可选 `responses` 或 `chat-completions` |
| `providers[].supportsEncryptedAgentMessages` | - | - | `false` | 是否让原生 Responses 上游直接处理 Multi-agent `agent_message`；仅允许用于 `responses` Provider。默认关闭时，网关会兼容解包 Codex 自定义 Provider 发出的子代理任务 |
| `providers[].models[].id` | - | - | - | Codex 路由模型 ID，支持 `.`, `_`, `/`, `:`、`+` 和单连字符；不能包含保留分隔符 `--` |
| `providers[].models[].inputModalities` | - | - | 按 `model-capabilities.json` 推断 | 模型输入能力，可选 `text`、`image`，且必须包含 `text`；显式配置优先于自动识别 |
| `providers[].models[].supportsHostedWebSearch` | - | - | `false` | 是否向 Codex 暴露 Responses Hosted Web Search；仅允许用于 `responses` Provider |
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
| `token` | `--token` | `DS_GATEWAY_TOKEN` | 空 | 推理代理 Bearer token；启用后要求独立管理令牌 |
| `adminToken` | - | `DS_GATEWAY_ADMIN_TOKEN` | 空 | 控制台和管理 API 令牌；必须与 `token` 不同且至少 16 个字符 |

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
- `GET /v1/models`：列出当前可调用的 Provider 模型别名；Codex 原生 agent 不作为模型暴露。
- `GET/POST /api/providers`：读取脱敏配置或添加 Provider。
- `PATCH/DELETE /api/providers/:id`：修改或删除 Provider。
- `PATCH/DELETE /api/providers/:id/keys/:name`：热更新 Key 的启用状态或权重，或删除 Key。
- `POST /api/providers/:id/keys/import`：批量解析、去重并原子导入 Key；响应只返回新增数、忽略数和脱敏元数据。
- `POST /api/providers/:id/keys/:name/test`：使用指定 Key 测试上游连接，包括已停用 Key。
- `POST /api/providers/:id/keys/:name/balance`：立即刷新指定 Key 的额度并返回新的 Key 状态。
- `GET/PATCH /api/settings`：读取或修改脱敏的 Gateway 标量设置；响应只返回 `tokenConfigured`，不会返回令牌内容。
- `POST /api/models`：通过 Provider 的 Base URL 和 Key 获取上游模型列表；支持 `/v1/models`、`/models` 及兼容子路径回退，不会自动写入配置。
- `GET /api/model-capabilities`：返回用于自动识别模型输入能力的集中目录和未知模型默认值。
- `POST /api/balance/test`：测试尚未保存的 `balanceQuery` 草稿；不会修改 Provider 配置。
- `POST /api/providers/:id/test`：测试 Provider 连接。
- `GET /api/codex/config`：生成统一 Codex Provider 和模型目录。
- `GET/DELETE /api/logs`：查询或清空运行日志。GET 支持 `search`、`level`、`provider`、`model`、`status`、`limit`（1-1000）和 opaque `cursor`；响应为 `{ logs, total, hasMore, nextCursor }`，按 `timestamp DESC, id DESC` 稳定分页。CSV 由浏览器本地生成，不会保存到服务器。
- `GET /api/usage?range=24h|7d|30d`：读取按天、Provider 和模型聚合的请求及 token 用量，响应包含 `total`、`points`、`providers` 和 `models`。Codex 客户端是子代理线程归属的事实来源，Gateway 不从普通模型请求猜测 agent 身份。用量 CSV 同样只在浏览器本地生成。
- `GET/POST /api/storage`：读取存储状态，或使用 `backup`、`restore` 动作管理配置备份。
- `DELETE /api/storage/backups/:id`：删除指定配置备份。
- `GET/POST/PATCH/DELETE /api/integrations`：管理 HTTP 集成；`POST /api/integrations/:id/test` 使用 5 秒超时且不会返回上游响应正文。
- `GET/POST/PATCH/DELETE /api/subagents`：管理并投影 Codex 原生 agent 配置；GET 项目附带 live 文件的 `projection` 状态。
- `POST /api/runtime/stop`：确认响应后优雅停止当前网关实例。
- `GET /login`：输入 `adminToken`，签发 24 小时 HttpOnly、SameSite Cookie；可信本机 HTTPS 反向代理下同时设置 `Secure`。
- 登录失败按直接 socket 来源执行进程内限流：默认 60 秒内最多记录 5 次失败，超限后冷却 5 分钟；成功登录会清除该来源的失败记录。限流状态在进程重启后清空，多实例之间不共享，也不会无条件信任 `X-Forwarded-For`。
- `GET /logout`：清除面板会话。

启用认证后：

- 代理 API 必须使用 `Authorization: Bearer <token>`。
- 浏览器使用独立 `adminToken` 通过 `/login` 登录后可以访问面板、`/health` 和管理 API；Cookie 会话的写操作必须携带匹配当前协议和 Host 的 `Origin`，Bearer 管理调用可用于非浏览器自动化。
- 管理令牌轮换后旧会话立即失效，当前设置页面会签发绑定新令牌的 Cookie。登录结果及管理写操作会以 `audit` 级别记录，但不记录请求体、令牌或密钥。
- 面板 Cookie 不能调用代理 API。
- 页面和健康接口不会返回 API Key 内容。

默认只监听 `127.0.0.1`。如果改为 `0.0.0.0` 或其他外部地址，应启用强随机 token，并通过可信反向代理提供 TLS。

## 测试

当前以本地质量门禁为主，暂不建设 CI。首次准备开发环境：

```bash
npm install
npm --prefix ui install
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
```

日常开发检查（Node.js、UI 测试，以及 UI lint、类型检查和生产构建）：

```bash
npm run check
```

提交或发布前执行完整本地验收（额外包含 Python 测试）：

```bash
npm run check:all
```

也可以按需执行分项命令：

```bash
npm run test:node
npm run test:python
npm run test:ui
npm run lint
npm run typecheck
npm run build
```

根目录 `npm test` 使用固定的 Node TAP、pytest 和 Vitest 命令，并隔离调用者追加的 runner 参数；需要直接向 Vitest 传参时使用 `npm --prefix ui test -- <vitest 参数>`。

测试使用内置 mock 上游，不消耗真实 API Key。UI 单元测试覆盖 Provider 草稿转换、脱敏提交载荷、模型去重、Hosted Web Search 协议切换、reasoning 能力保留和额度格式化。Key 后缀可触发不同 mock 行为：

| 后缀 | 行为 |
| --- | --- |
| `-ok` | 正常响应 |
| `-429` | 返回 429 |
| `-500` | 返回 500 |
| `-401` | 返回 401 |
| `-slow` | 延迟响应 |
| `-drip` | 分段流式响应 |
| `-abort` | 流式传输中断 |

测试覆盖轮询与并发调度、Provider 别名隔离、独立冷却、运行时增量 Key、批量解析与原子导入、重复 secret 拒绝、上游模型发现与 ID 归一化、Responses 与 Chat Completions 双向转换、工具调用和分片 SSE 终止事件、切换上游时的请求排空、QuickJS 额度脚本隔离与请求限制、自动和手动额度刷新、429 切换、401/402 永久剔除、5xx 累计失败黑名单、SSE 透传、流式生命周期、Provider 与 Settings API 脱敏、热更新和原子持久化、运维 JSON 迁移/损坏恢复/并发写入、Web-first 引导、Codex 动态目录、token/Cookie 权限隔离、CSRF、会话失效、审计、请求体上限、`gatewayctl` 托管启动和安全停止、交互式配置及备份恢复。
