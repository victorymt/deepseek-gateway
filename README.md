# deepseek-gateway

本地多 Provider Codex 网关。它把多个 OpenAI Responses 兼容上游接入同一个地址，每个 Provider 拥有独立 KeyPool、冷却、失败状态和统计。Codex 只配置一个 Gateway Provider，并可直接通过 `/model` 在 `provider--model` 别名之间切换。

```text
Codex / API client
        |
        |  http://127.0.0.1:8787
        v
gateway.mjs  -- 根据请求 model 解析 provider--model
        |
        +-- DeepSeek KeyPool  -- deepseek--v4-flash
        +-- OpenRouter KeyPool -- openrouter--claude-sonnet
        +-- 其他 Responses 兼容 Provider
```

## 运行要求

- Node.js 18 或更新版本；构建 shadcn 状态面板需要 Node.js 20.19+ 或 22.12+，以及 npm
- Python 3.10 或更新版本，用于交互式配置和 Codex 配置合并；推荐 Python 3.11+
- Codex CLI，仅在需要接入 Codex 时使用

网关核心仍是零依赖 Node.js 进程。React/shadcn 状态面板的依赖隔离在 `ui/` 目录中。

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
2. 配置初始 Provider 的上游地址，隐藏输入一个或多个 API Key，并设置名称和权重。
3. 可选启用网关访问密码。
4. 通过网关共用的配置校验器生成并安全写入 v2 `keys.json`。
5. 自动安装依赖并构建 shadcn 状态面板（可通过 `--no-ui` 跳过）。
6. 可选同步 Codex CLI 配置。
7. 检查监听地址：已有可访问的网关则直接复用，端口空闲时可选立即启动。

启动后可在面板的“Provider 管理”中添加、编辑、测试或删除其他上游，并在“Gateway 设置”中管理监听参数、运行策略和访问令牌。手工创建的旧版 `{ upstream, keys }` 配置仍可加载，并会在首次通过面板修改时以 v2 结构原子写回。

如果向导中没有选择立即启动，运行：

```bash
./gatewayctl start --config keys.json
```

默认地址：

- 状态面板：`http://127.0.0.1:8787/`
- 健康检查：`http://127.0.0.1:8787/health`

## 交互式配置

```bash
./gatewayctl init
```

直接回车会接受当前值。再次运行向导时，可以保留现有 API Key，也可以重新录入全部 Key。

向导会先检查目标地址。检测到网关正在运行时不会直接改写离线配置，而是引导到状态面板；需要修改监听参数时，应先停止网关再运行向导。

向导具有以下安全行为：

- API Key 和网关密码在终端中隐藏输入。
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
      "enabled": true,
      "models": [
        { "id": "v4-flash", "name": "V4 Flash", "upstreamModel": "deepseek-v4-flash" }
      ],
      "keys": [
        { "name": "primary", "key": "sk-你的Key", "weight": 1, "enabled": true }
      ]
    }
  ]
}
```

也可以完全使用环境变量，不创建 `keys.json`：

```bash
DEEPSEEK_KEYS="main=sk-xxx,backup=sk-yyy" node gateway.mjs
```

## 接入 Codex

推荐在 `gatewayctl init` 中选择“同步配置到 Codex CLI”，或在面板的“Codex 配置”中预览和下载生成物。

也可以单独运行：

```bash
./gatewayctl codex --dry-run
./gatewayctl codex
```

`setup-codex.sh` 仍可作为底层兼容入口直接运行。

脚本会备份并合并：

- `~/.codex/config.toml`
- `~/.codex/gateway-models.json`

自定义模型和网关地址：

```bash
MODEL="deepseek--v4-pro" \
GATEWAY_URL="http://127.0.0.1:8787" \
./setup-codex.sh
```

生成的 Provider 使用 `env_key`，不会把 Gateway token 或上游 API Key 写进 Codex 配置。启动 Codex 前设置：

```bash
export DEEPSEEK_GATEWAY_TOKEN="你的网关密码"
```

完成后，在任意项目目录运行：

```bash
codex
```

启动信息应显示 `deepseek--v4-flash` 或配置的默认别名。在 Codex 内执行 `/model` 即可切换到其他 Provider 的别名；新增目录项后需要重启一次 Codex 以重新加载 `model_catalog_json`。恢复最近一次 Codex 配置备份：

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

## 调度策略

每个 Provider 的 KeyPool 分别维护并发数、成功数、错误数、429 次数、累计失败数、冷却截止时间和失效状态。同名上游模型不会共享 Key、冷却或失败状态。

在面板中编辑 Provider 并添加 Key 后，新 Key 会立即加入正在运行的调度池，无需重启网关。未改变的 Key 按 secret 指纹复用原状态，因此改名或调整权重不会清空其统计、冷却、失效状态或余额；删除 Key 也不会中断已经使用它的请求。修改 Provider 的 `baseUrl` 时，新请求立即切换到新上游，旧 runtime 会等待进行中的响应（包括 SSE 长流）结束后再释放连接。

当上游为 `api.deepseek.com` 时，网关启动后会立即通过 DeepSeek `/user/balance` 查询每个 Key 的余额，并按 `balanceRefreshMs` 在后台刷新。其他自定义或 OpenAI 兼容上游不会发起余额请求。查询失败只记录在面板和 `/health` 中，不计入 Key 的业务失败次数；设置为 `0` 可禁用余额查询。

| 事件 | 处理 |
| --- | --- |
| 正常响应 | 记录成功并清除冷却状态，不清零累计失败数 |
| `429` | 优先使用 `Retry-After`，否则按 `cooldownMs` 冷却，并切换 Key 重试 |
| `5xx` / 网络错误 | 增加累计失败数；达到 `blacklistThreshold` 后标记为 `invalid` |
| `401` / `402` / `403` | 立即标记为 `invalid`，永久移出当前进程的调度池 |
| 全部 Key 冷却或失效 | 返回 `502 no keys available`，不再强行调度不可用 Key |

正常情况下，调度器先排除停用、冷却和失效 Key，再选择 `inFlight / weight` 最小的 Key，平分时使用轮询游标。`inFlight` 会保持到响应体完整结束，因此长时间 SSE 请求也参与并发均衡。每个 Provider 至少需要保留一个 `enabled: true` 的 Key。

每个请求最多切换 `min(maxRetries, 已启用 Key 数量 - 1)` 次。失败切换发生在向客户端写出响应头之前；流式传输开始后的上游中断会记录为该 Key 的网络错误。

## 配置参考

标量配置优先级为：命令行 > 环境变量 > `keys.json` > 默认值。`--keys`、`DEEPSEEK_KEYS` 和 `--upstream` 作为兼容入口作用于默认 Provider；旧版 `{ upstream, keys }` 配置会在内存中迁移为 `deepseek` Provider。

环境变量和命令行参数只影响本次运行，不会通过管理 API 回写到 `keys.json`。当 `--keys`、`DEEPSEEK_KEYS`、`--upstream` 或 `DS_UPSTREAM` 覆盖 Provider 配置时，Provider 管理写操作会返回 `409`；移除覆盖并重启后即可恢复写入。这可以避免运行时传入的 Key 被意外持久化。

“Gateway 设置”会显示持久化值、当前生效值和覆盖来源。`cooldownMs`、`blacklistThreshold`、`balanceRefreshMs`、`maxRetries`、`timeoutMs`、`maxBodyBytes` 和 `token` 在没有运行时覆盖时热生效；`host` 和 `port` 保存后需要重启。被命令行或环境变量接管的字段在面板中为只读，覆盖值不会写入配置文件。

| JSON 字段 | 命令行 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `port` | `--port` | `DS_GATEWAY_PORT` | `8787` | 监听端口 |
| `host` | `--host` | - | `127.0.0.1` | 监听地址 |
| `providers[]` | - | - | DeepSeek 兼容项 | Provider 的 `id`、`baseUrl`、`models`、`keys` 和启用状态 |
| `defaultProvider` | - | - | 第一个启用项 | 未带别名前缀时使用的 Provider |
| `defaultModel` | - | - | 默认 Provider 首个模型 | Codex 启动模型别名 |
| `upstream` | `--upstream` | `DS_UPSTREAM` | `https://api.deepseek.com` | 旧配置/默认 Provider 上游 URL |
| `keys[]` | `--keys` | `DEEPSEEK_KEYS` | - | 旧配置/默认 Provider Key |
| `cooldownMs` | `--cooldown-ms` | `DS_COOLDOWN_MS` | `60000` | 429 冷却时间 |
| `blacklistThreshold` | `--blacklist-threshold` | `DS_BLACKLIST_THRESHOLD` | `3` | 累计失败黑名单阈值；0 表示禁用 |
| `balanceRefreshMs` | `--balance-refresh-ms` | `DS_BALANCE_REFRESH_MS` | `300000` | Key 余额后台刷新间隔；0 表示禁用 |
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
- `POST /api/providers/:id/keys/:name/test`：使用指定 Key 测试上游连接，包括已停用 Key。
- `GET/PATCH /api/settings`：读取或修改脱敏的 Gateway 标量设置；响应只返回 `tokenConfigured`，不会返回令牌内容。
- `POST /api/models`：通过 Provider 的 Base URL 和 Key 获取上游模型列表；支持 `/v1/models`、`/models` 及兼容子路径回退，不会自动写入配置。
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
node --test test/config-core.mjs test/gatewayctl.mjs test/smoke.mjs
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

测试覆盖轮询与并发调度、Provider 别名隔离、独立冷却、运行时增量 Key、重复 secret 拒绝、上游模型发现与 ID 归一化、切换上游时的请求排空、逐 Key 余额、429 切换、401/402 永久剔除、5xx 累计失败黑名单、SSE 透传、流式生命周期、Provider 与 Settings API 脱敏、热更新和原子持久化、Codex 动态目录、token/Cookie 权限隔离、请求体上限、`gatewayctl`、交互式配置和备份恢复。
