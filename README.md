# deepseek-gateway

本地 DeepSeek 多 Key 网关。它使用一个零依赖 Node.js 进程把多个 DeepSeek API Key 汇聚成统一入口，并提供负载均衡、限流冷却、熔断、失败切换、流式透传和状态面板，可直接接入 Codex CLI。

```text
Codex / API client
        |
        |  http://127.0.0.1:8787
        v
gateway.mjs  -- 最少并发 + 权重 + 轮询游标
        |       429 冷却切换 / 5xx 熔断 / 401、403 剔除
        v
https://api.deepseek.com
```

## 运行要求

- Node.js 18 或更新版本
- Python 3.10 或更新版本，用于交互式配置和 Codex 配置合并；推荐 Python 3.11+
- Codex CLI，仅在需要接入 Codex 时使用

项目本身没有 npm 依赖，不需要执行 `npm install`。

## 快速开始

进入项目目录并运行配置向导：

```bash
cd deepseek-gateway
./configure.py
```

向导会依次完成：

1. 配置监听地址、上游、冷却、熔断、重试、超时和请求体上限。
2. 隐藏输入一个或多个 DeepSeek API Key，并为每个 Key 设置名称和权重。
3. 可选启用网关访问密码。
4. 安全写入 `keys.json`。
5. 可选同步 Codex CLI 配置。
6. 可选立即启动网关。

如果向导中没有选择立即启动，运行：

```bash
node gateway.mjs --config keys.json
```

默认地址：

- 状态面板：`http://127.0.0.1:8787/`
- 健康检查：`http://127.0.0.1:8787/health`

## 交互式配置

```bash
./configure.py
```

直接回车会接受当前值。再次运行向导时，可以保留现有 API Key，也可以重新录入全部 Key。

向导具有以下安全行为：

- API Key 和网关密码在终端中隐藏输入。
- `keys.json` 通过原子替换写入，文件权限设置为 `600`。
- 修改现有配置前，会备份到 `.gateway-backups/`。
- `keys.json` 和 `.gateway-backups/` 均已加入 `.gitignore`。
- Key 名称必须唯一，权重必须是大于零的有限数值。

自定义配置路径：

```bash
./configure.py --config /path/to/keys.json
```

只生成网关配置，不接入 Codex，也不询问是否启动：

```bash
./configure.py --no-codex --no-start
```

完整选项：

```text
--config PATH  指定配置文件，默认 ./keys.json
--no-codex     不询问 Codex CLI 接入
--no-start     不询问立即启动网关
```

## 手工配置

不使用向导时，可以复制示例文件：

```bash
cp keys.example.json keys.json
```

然后编辑 `keys.json`：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "upstream": "https://api.deepseek.com",
  "cooldownMs": 60000,
  "breakerThreshold": 5,
  "maxRetries": 2,
  "timeoutMs": 0,
  "maxBodyBytes": 67108864,
  "token": "",
  "keys": [
    { "name": "primary", "key": "sk-你的第一个Key", "weight": 1 },
    { "name": "backup", "key": "sk-你的第二个Key", "weight": 1 }
  ]
}
```

也可以完全使用环境变量，不创建 `keys.json`：

```bash
DEEPSEEK_KEYS="main=sk-xxx,backup=sk-yyy" node gateway.mjs
```

## 接入 Codex

推荐在 `configure.py` 中选择“同步配置到 Codex CLI”。向导会把网关 URL、模型和网关密码一起传给安装脚本，避免两侧 token 不一致。

也可以单独运行：

```bash
./setup-codex.sh --dry-run
./setup-codex.sh
```

脚本会备份并合并：

- `~/.codex/config.toml`
- `~/.codex/models.json`

自定义模型和网关地址：

```bash
MODEL="deepseek-v4-pro" \
GATEWAY_URL="http://127.0.0.1:8787" \
./setup-codex.sh
```

如果 `keys.json` 中设置了 `token`，单独执行安装脚本时必须传入相同值：

```bash
GATEWAY_TOKEN="你的网关密码" ./setup-codex.sh
```

完成后，在任意项目目录运行：

```bash
codex
```

启动信息应显示 `deepseek-v4-flash` 或配置时选择的模型。恢复最近一次 Codex 配置备份：

```bash
./setup-codex.sh --undo
```

## 调用网关

未设置网关 `token` 时：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

设置了网关 `token` 时，需要发送 Bearer token：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer 你的网关密码' \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

网关会原样转发请求方法、路径和请求体，因此 `/v1/responses`、`/v1/chat/completions` 及其他上游路径均可使用。响应头 `X-Gateway-Key` 表示本次请求由哪个 Key 提供服务。

## 调度策略

每个 Key 会维护并发数、成功数、错误数、429 次数、连续失败数、冷却截止时间和失效状态。

| 事件 | 处理 |
| --- | --- |
| 正常响应 | 记录成功，重置冷却和连续失败计数 |
| `429` | 优先使用 `Retry-After`，否则按 `cooldownMs` 冷却，并切换 Key 重试 |
| `5xx` / 网络错误 | 增加连续失败计数；达到 `breakerThreshold` 后熔断冷却 |
| `401` / `403` | 标记为 `invalid`，永久移出调度池 |
| 全部 Key 冷却 | 选择最早恢复的非失效 Key 降级服务 |
| 全部 Key 失效 | 返回 `502 no keys available` |

正常情况下，调度器先排除冷却和失效 Key，再选择 `inFlight / weight` 最小的 Key，平分时使用轮询游标。`inFlight` 会保持到响应体完整结束，因此长时间 SSE 请求也参与并发均衡。

每个请求最多切换 `min(maxRetries, Key 数量 - 1)` 次。失败切换发生在向客户端写出响应头之前；流式传输开始后的上游中断会记录为该 Key 的网络错误。

## 配置参考

标量配置优先级为：命令行 > 环境变量 > `keys.json` > 默认值。来自配置文件、环境变量和命令行的 Key 会合并到同一个池中。

| JSON 字段 | 命令行 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `port` | `--port` | `DS_GATEWAY_PORT` | `8787` | 监听端口 |
| `host` | `--host` | - | `127.0.0.1` | 监听地址 |
| `upstream` | `--upstream` | `DS_UPSTREAM` | `https://api.deepseek.com` | 上游基础 URL |
| `keys[]` | `--keys` | `DEEPSEEK_KEYS` | - | Key 的 `name`、`key`、`weight` |
| `cooldownMs` | `--cooldown-ms` | `DS_COOLDOWN_MS` | `60000` | 429 和熔断冷却时间 |
| `breakerThreshold` | `--breaker` | `DS_BREAKER` | `5` | 连续失败熔断阈值 |
| `maxRetries` | `--max-retries` | `DS_MAX_RETRIES` | `2` | 每次请求最多切换次数 |
| `timeoutMs` | - | - | `0` | 上游超时；0 表示不限 |
| `maxBodyBytes` | `--max-body-bytes` | `DS_MAX_BODY_BYTES` | `67108864` | 请求体大小上限；超限返回 413 |
| `token` | `--token` | `DS_GATEWAY_TOKEN` | 空 | 网关访问密码 |

指定其他配置文件：

```bash
node gateway.mjs --config /path/to/keys.json
```

也可以设置 `DS_GATEWAY_CONFIG`。

## 面板与鉴权

- `GET /`：状态面板，每 2 秒刷新一次。
- `GET /health`：JSON 健康状态，适合脚本和监控。
- `GET /login`：输入网关 `token`，签发 24 小时 HttpOnly、SameSite Cookie。
- `GET /logout`：清除面板会话。

启用 `token` 后：

- 代理 API 必须使用 `Authorization: Bearer <token>`。
- 浏览器通过 `/login` 登录后可以访问面板和 `/health`。
- 面板 Cookie 不能调用代理 API。
- 页面和健康接口不会返回 API Key 内容。

默认只监听 `127.0.0.1`。如果改为 `0.0.0.0` 或其他外部地址，应启用强随机 token，并通过可信反向代理提供 TLS。

## 测试

运行完整测试：

```bash
node --test test/smoke.mjs
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

测试覆盖轮询与并发调度、429 切换、401 永久剔除、5xx 熔断、SSE 透传、流式生命周期、上游中断、token/Cookie 权限隔离、请求体上限、面板转义、交互式配置、Codex 配置幂等和备份恢复。
