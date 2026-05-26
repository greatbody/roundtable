# Roundtable

[![Build](https://github.com/greatbody/roundtable/actions/workflows/build.yml/badge.svg)](https://github.com/greatbody/roundtable/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Container](https://img.shields.io/badge/ghcr.io-greatbody%2Froundtable-2496ED?logo=docker)](https://github.com/greatbody/roundtable/pkgs/container/roundtable)

后台驱动的多智能体讨论平台。讨论运行在后台，WebUI 仅作交互窗口；关闭浏览器讨论照常进行。

## 一键运行（Docker）

```bash
docker run -d --name roundtable -p 3001:3001 \
  -v roundtable-data:/data \
  -e DEEPSEEK_API_KEY=sk-... \
  -e OIDC_ISSUER=https://your-sso.example.com \
  -e OIDC_CLIENT_ID=... \
  -e OIDC_CLIENT_SECRET=... \
  -e PUBLIC_BASE_URL=http://localhost:3001 \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  ghcr.io/greatbody/roundtable:latest
```

镜像支持 `linux/amd64` + `linux/arm64`，约 103 MB。

> 更推荐使用 **[docker-compose/](./docker-compose/)** 目录里的 compose 模板，自带 named volume、healthcheck 和 `.env` 模板。

## 核心特性

- **讨论组（Group）** = agent 身份模板集合（无数据）
- **会话（Conversation）** = 实例化的话题，独立 event_log，多 conversation 互相隔离
- **AgentInstance** = agent 在某个 conversation 内的活体，独立 working_memory
- **Pub-Sub 群聊语义** = 一个事件总线，agent 订阅，自决发言
- **自决发言** = agent 看自己上下文，输出 `{speak: false}` 或 `{speak: true, content, address?}`
- **沉默不入 channel** = 沉默响应不会触发其他 agent 的连锁反应
- **思考风暴抑制** = debounce + cooldown + 动态 cooldown + 并发上限
- **缓存友好** = 稳定前缀 + 不可变 event + digest 分段冻结
- **Provider 抽象** = MVP 接入 DeepSeek，可扩展 OpenAI/Anthropic/Gemini
- **软删除** = 删除 agent 不影响历史 conversation

详细规则见 [REQUIREMENTS.md](./REQUIREMENTS.md)。

## 快速启动

```bash
# 安装依赖
bun install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填写：
#   - DEEPSEEK_API_KEY    (LLM 全局共享)
#   - OIDC_ISSUER         (默认 https://sso.sunrui.ink)
#   - OIDC_CLIENT_ID      (在 Rauthy 后台创建 confidential client 后获取)
#   - OIDC_CLIENT_SECRET
#   - PUBLIC_BASE_URL     (默认 http://localhost:3001)
#   - SESSION_SECRET      (openssl rand -base64 48)

# 启动
bun run dev
```

浏览器访问 http://localhost:3001 — 未登录会被重定向到 SSO 登录页。

## 多用户与认证

- 通过 [Rauthy](https://github.com/sebadob/rauthy) OIDC 完成 SSO
- 流程：OIDC Authorization Code + PKCE，server-side 兑换，HTTP-only Cookie 会话（默认 30 天滚动）
- **数据完全隔离**：每个 `group` / `agent` / `conversation` 都有 `owner_id`，用户只能看到/操作自己的资源
- `DEEPSEEK_API_KEY` 全局共享（服务端持有）

### 在 Rauthy 中创建 Client
1. 登录 Rauthy 管理后台
2. 创建 Confidential Client
3. Redirect URI 填 `{PUBLIC_BASE_URL}/auth/callback`（默认 `http://localhost:3001/auth/callback`）
4. 启用 PKCE (S256)，Grant Type 选 `authorization_code`
5. 把 client_id / client_secret 填入 `.env`

## 项目结构

```
src/
  core/           # 业务核心：类型、存储、event bus、调度、压缩、渲染
  providers/      # LLM provider 抽象与适配器
  auth/           # OIDC 客户端、会话、登录路由
  api/            # HTTP + SSE
  web/            # 极简 WebUI（无框架）
  index.ts        # 入口
data/             # SQLite 数据库（自动创建）
```

## 默认数据示例

首次创建讨论组时，对话框会预填一个示例 group（"产品评审组"），含产品经理 / 工程师 / 设计师三位 agent，可直接基于它创建会话开聊。

## License

MIT — 详见 [LICENSE](./LICENSE)。
