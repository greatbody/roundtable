# Roundtable — 需求文档

后台驱动的多智能体讨论平台。本文档汇总了设计讨论的全部规则与不变量，作为实现依据。

---

## 0. 核心心智模型

> **讨论是一等公民，UI/API 只是观察窗口。**

讨论运行在后台守护循环里。WebUI / CLI / 移动端通过订阅事件流来"旁观"或"插话"。关掉浏览器不影响讨论。

---

## 1. 四层概念模型

| 概念 | 性质 | 数据 |
|---|---|---|
| **AgentDefinition (池)** | 全局可复用的 agent 模板（人设/模型/参数） | 不持有运行时数据；与 Group 多对多关系 |
| **Group** | Agent 引用集合 + 默认配置 | 不持有讨论数据；只挂成员关系 |
| **Conversation** | 实例化的话题，真正"活着"的对象 | event_log、参与者实例、状态 |
| **AgentInstance** | agent 在某 Conversation 内的活体 | working_memory（digest + recent_events + cooldown） |

**多对多成员关系**：`group_members(group_id, agent_id, added_at)` 是 Group 与 AgentDefinition 之间的唯一真相源。一个 agent 可在多个 group 中复用，编辑 agent 即时同步给所有 group（只影响**未来**新会话，运行中的会话仍用 instance snapshot — I10）。

> **AgentDefinition ≈ 全城专家名册；Group ≈ 圆桌俱乐部章程（圈选若干专家入会）；Conversation ≈ 一次具体的圆桌会议；AgentInstance ≈ 该专家在本次会议里的活体。**

---

## 2. 不变量（系统正确性边界）

实现必须永远满足以下命题。任何优化不得违反：

1. **I1 自决不可剥夺**：不存在让 agent "被迫"发言的代码路径。
2. **I2 身份段稳定**：同一 AgentInstance 在 Conversation 生命周期内 system_prompt 字节级一致。
3. **I3 Digest 单调增长**：digest 只 append，不 rewrite。
4. **I4 Recent 单调追加**：除压缩动作外 `recent_events` 只追加。
5. **I5 压缩无损视角**：压缩后 agent 能继续连贯讨论，不丢"我说过什么"和"谁 @ 过我"。
6. **I6 事件日志是冗余真相**：任何 working_memory 都可从事件日志 + 当前 digest 状态重建。
7. **I7 沉默不污染他人**：silence 事件不进入其他 agent 的 recent_events。
8. **I8 @ 无强制力**：被 @ 的 agent 可以输出 `{"speak": false}`。
9. **I9 Conversation 隔离**：任意两 Conversation 的 event_log 与 AgentInstance 物理隔离。
10. **I10 AgentDefinition 只读于 Conversation**：Conversation 启动时快照 AgentDefinition，之后修改不影响该 Conversation。
11. **I11 Conversation 是数据单元**：备份/删除/导出/fork 以 Conversation 为单位。

---

## 3. 行为规则

### 3.1 Agent 自决（规则 1, 9, 17）
- 是否发言**只**由 agent 看自己的 context 后产出。
- 单次 LLM 调用 + 结构化 JSON 输出：
  ```json
  { "speak": false }
  { "speak": true, "content": "...", "address": ["instance_id", ...] }
  ```
- system_prompt 中明确教育："你不必每次都发言。当你没有新观点 / 已有人代你表达 / 想继续倾听时，输出 `{\"speak\": false}`。"

### 3.2 @ 是邀请，不是命令（规则 2）
- 被 @ 仅在该 agent 下次 context 中体现为 `addresses_you="true"` 标记。
- agent 看到标记后仍自决。
- @ 的唯一系统效果：让被 @ 者**绕过 cooldown**，进入下一周期候选池。
- 不支持 `@all`。
- @ 双通道：content 内可写 `@instance_id`，schema 强制输出 `address` 数组，二者求并集 + 一致性校验。
- @ 不存在的 id：保留 content 原文，address 数组过滤掉，记 warning 事件。

### 3.3 独立工作记忆（规则 3, 6）
每个 AgentInstance 拥有：
```ts
WorkingMemory {
  system_prompt          // 身份 + 群组背景 + 规则（永不变）
  digest_segments[]      // append-only 摘要段
  recent_events[]        // 自上次压缩以来的增量事件
  cooldown_until         // 调度过滤用
  pending_addresses[]    // 自上次调用以来被 @ 的记录
  silent_streak          // 连续沉默次数（动态 cooldown 用）
  state_version
}
```

### 3.4 上下文装配（规则 4）
```
provider_request.system   = working_memory.system_prompt
provider_request.messages = [
  { role: "user", content: "<digest>" + concat(digest_segments) + "</digest>" },
  ...recent_events.map(toMessage),
  { role: "user", content: "<your_turn ... />" }
]
```

**Role 映射**：
- 自己之前的发言 → `assistant`。
- 他人发言 / 用户发言 → `user`，content 内 `<turn speaker="..." addresses_you="...">...</turn>` 包裹。
- 相邻多条 "他人" event 可合并为单个 user message 内多段 `<turn>`（C9 缓存优化）。

### 3.5 严格轮次模型（Round-based — 替换原 pub-sub 模型）

讨论以**显式轮次**推进，每轮所有 agent 并发自决一次。

**单轮流程**：
1. 外部触发（用户消息 / topic / poke）入库并**立即** fan-out 给所有 agent 的 `recent_events`，UI 立即看到。
2. 当前轮内的所有非删除 agent **并行**调用 LLM（每人一次）。
3. 每个 agent 产出后：
   - 选择发言 → 立即落库 + 推送给 **UI**，但**暂不**进入其他 agent 的 context（避免 mid-round cascade）。
   - 选择沉默 → `self_only` 入库，私有可见，不入 UI 不入他人 context。
4. 等**所有 agent 都完成**后，**批量**把本轮发言（+ 中途到达的外部事件）一次性 fan-out 给所有 agent 的 `recent_events`。
5. 触发条件：
   - 本轮 ≥1 发言，自动进入下一轮（reason=`followup`）。
   - 本轮零发言但有 pending 外部触发，进入下一轮（reason=`external-during-round`）。
   - 本轮零发言且无外部触发，**讨论进入 idle**，停止所有 LLM 调用。
6. 第 2 轮及之后，trigger 段加入提示："仅当被启发需要补充/纠正/追问时才发言；否则沉默"。

**关键性质**：
- **绝不级联**：本轮内 agent A 的发言绝不会引起 agent B 在本轮再被叫醒。
- **绝不轮询**：idle 状态零 LLM 调用，无 heartbeat、无防抖、无 polling。
- **bounded cost**：单次外部触发引发的总 LLM 调用数 = `轮数 × agent 数`，轮数由 agent 自决终止。
- **mid-round 用户插话**：消息立即入库+UI，但 fan-out 推迟到当前轮末，下一轮起 agent 才能感知。

**移除的旧机制**：
- ❌ Pub-sub 内部 channel（bus 仅保留给 UI 订阅）
- ❌ 防抖 debounce
- ❌ 心跳 heartbeat
- ❌ cooldown_until_seq（每轮全员有发言机会）
- ❌ topic_stalled 标记（idle 本身即信号）
- ❌ silent_streak 动态 cooldown

### 3.6 压缩（规则 6）
- 每个 AgentInstance 独立压缩。
- 触发：`tokens(messages) > threshold(provider.context_window)`，默认 60%。
- 第一人称压缩（"我（X）听到 ... 我说过 ... 当前焦点是 ..."）。
- 产物追加为新 digest_segment，旧段冻结。
- 被压缩的 events 从 recent_events 移除。

### 3.7 触发与终止
- 外部触发源（user message / topic / poke）→ 启动 round 1。
- 每轮结束自动判断：有人发言 ⇒ 自动 round N+1；零发言 ⇒ idle。
- idle 状态下**绝无任何 LLM 调用**。
- mid-round 用户插话：缓冲到当前轮末，与本轮发言一同 fan-out，并触发后续轮。

### 3.8 软删除（规则 12, 13, 14）
- 所有可引用对象（Group, AgentDefinition, User）有 `deleted_at`，永不物理删除。
- 引用方保留快照：
  - `AgentInstance.definition_snapshot` 全文拷贝。
  - `Event.speaker_snapshot` 拷贝 display_name + definition_id + version。
  - `Conversation.group_snapshot` 拷贝创建时的 group 元数据。
- 软删除可撤销。
- 新 Conversation 创建时默认过滤掉已删 agent；历史 Conversation 不受影响。

### 3.9 用户作为参与者（规则 10）
- 用户插话 = `kind=user_message, speaker.kind=user` 事件，正常入 channel 并 fan-out。
- 用户可携带 `address` 数组。
- 用户**不参与邀请周期**（不会被自动 LLM 调用）。
- 用户发言会触发新一轮邀请周期。

---

## 4. 缓存命中最大化（C1-C12）

- **C1 严格"稳定前缀 + 变动尾部"分层**
- **C2 Event 序列化不可变**：rendered string 一次生成永久冻结
- **C3 入队即渲染**：写入 recent_events 时立即渲染并存储
- **C4 前缀内严禁时间戳/计数器**
- **C5 JSON/XML 序列化稳定**（key 顺序、缩进、Unicode 归一化）
- **C6 Trigger 段 ≤ 50 tokens**
- **C7 显式 cache_hints**（provider 适配器翻译为各家原生缓存控制）
- **C8 压缩成本平摊**（阈值 60-70%，批量压缩）
- **C9 Recent_events 合并按"上一次自己发言"切分**
- **C10 每 AgentInstance 独立 cache lane**
- **C11 5 分钟过期感知**（v2 可加 warm-keep 心跳）
- **C12 Digest 分段冻结**

---

## 5. Provider 抽象层

```ts
interface NormalizedRequest {
  system: string                      // 稳定段
  messages: NormalizedMessage[]       // digest + recent + trigger
  output_schema: JSONSchema           // 强制 {speak, content?, address?}
  cache_hints?: CacheHint[]           // 哪些段应标缓存
  max_output_tokens: number
  stop?: string[]
  temperature?: number
}

interface NormalizedResponse {
  parsed: { speak: boolean; content?: string; address?: string[] }
  raw_text: string
  usage: { input: number; output: number; cache_read: number; cache_write: number }
  finish_reason: string
}

interface LLMProvider {
  id: string
  capabilities(): { supports_cache: boolean; supports_tools: boolean; max_context: number }
  complete(req: NormalizedRequest): Promise<NormalizedResponse>
}
```

**MVP 实现**：DeepSeek 适配器（OpenAI 兼容 Chat Completions）。

---

## 6. 数据模型（SQLite）

参考 `src/core/storage.ts` 的 schema 定义。表清单：
- `groups`, `agent_definitions`
- `conversations`, `agent_instances`
- `events`

---

## 7. HTTP API（无鉴权 MVP）

```
# Agent 池（独立于任何 group 存在）
GET    /api/agents                            列出池中所有 agent
POST   /api/agents                            创建仅入池的 agent（无 group 归属）
GET    /api/agents/:id                        agent 详情（含其归属的所有 group）
PATCH  /api/agents/:id                        编辑 agent（版本 +1；只影响未来新会话）
DELETE /api/agents/:id                        软删 agent（所有 group 的成员关系自动失效）

# Group
GET  /api/groups                              列出所有 group
POST /api/groups                              创建 group
GET  /api/groups/:id                          group 详情（含其成员 agent）
DELETE /api/groups/:id                        软删 group
POST /api/groups/:id/agents                   创建 agent 并自动加入此 group（同时入池）
POST /api/groups/:id/members                  body: { agent_id }  把已有 agent 加入组
DELETE /api/groups/:id/agents/:aid            把 agent 从组中移除（不删除 agent，仅断开成员关系）
DELETE /api/groups/:id/members/:aid           同上（别名）
PATCH  /api/groups/:id/agents/:aid            编辑 agent（同 PATCH /api/agents/:aid）

# Conversation
GET  /api/conversations                       列出所有 conversation
POST /api/conversations                       启动 conversation
                                              body: { group_id, topic, participant_def_ids? }
GET  /api/conversations/:id                   conversation 状态
GET  /api/conversations/:id/events            事件历史（JSON 或 SSE 流）
POST /api/conversations/:id/messages          用户插话
                                              body: { content, address?: [instance_id] }
POST /api/conversations/:id/pause             暂停
POST /api/conversations/:id/resume            继续
POST /api/conversations/:id/finish            结束
POST /api/conversations/:id/poke              显式触发邀请周期
POST /api/conversations/:id/topic             修改话题
```

---

## 8. WebUI（极简 MVP）

单页 + SSE，侧边栏三区结构：

```
├── 智能体（可展开）── 全局 agent 池
│      ├─ agent A    [v3]   [删]
│      ├─ agent B    [v1]   [删]
│      └─ + 创建 agent（仅入池）
├── 讨论组
│      ├─ ▶ group X
│      └─ ▼ group Y
│            ├─ member A (来自池)   [移出]
│            ├─ member B (来自池)   [移出]
│            ├─ + 添加现有 agent（从池中挑选）
│            └─ + 创建 agent（同时加入本组与池）
└── 会话
       ├─ 话题 1
       └─ 话题 2
```

- 点击池中 agent / 组内成员行 → 编辑 dialog（修改池实体，所有 group 共享）。
- 池内 [删] = 软删 agent（断开所有 group 成员关系）。
- 组内 [移出] = 仅断开本组成员关系，agent 仍在池中。
- 右栏会话视图：参与者列表 / 话题注入条 / 事件 SSE 流 / 用户插话 composer。

---

## 9. MVP 边界

**包含**：
- Group / Conversation / AgentInstance 三层数据模型
- Pub-sub + 抑制层 1, 2, 5, 6, 7（默认）
- DeepSeek provider
- Per-agent 工作记忆 + 视角渲染 + 简单压缩
- @ 双通道 + addresses_you 标记
- 软删除
- SSE 事件流 WebUI
- 持久化与重启恢复

**暂不做**：
- 多用户 / 鉴权
- 工具调用 / RAG
- Embedding 相关性预筛（v2）
- Cache warm-keep 心跳（v2）
- Fork 操作（数据结构预留）
- 多 Conversation 并行的细粒度速率限制（v2）

---

## 10. 待迭代决策（已默认设置 MVP 值）

为了让 MVP 跑起来，本次实现采用以下默认值，未来可调：

| 项 | MVP 默认 |
|---|---|
| 实现语言 | Bun + TypeScript |
| 存储 | SQLite |
| 首批 Provider | DeepSeek |
| WebUI | 极简 SSE 单页 |
| 部署 | 单机自用 |
| digest 的 role | `user` 包裹 |
| 压缩执行者 | agent 自己（同一 provider） |
| 压缩视角 | 第一人称 |
| 长期沉默降级 | 否（v2） |
| max_wake_per_cycle | ∞（用户可调） |
| debounce | 300ms |
| 沉默是否带 reason | 否（v2 加） |
| 持久化粒度 | 即刻入库 |
| Conversation 启动 participants | 必须 ≥2 个 group 成员 |
| 运行中增减 participants | API 预留，MVP 未实现 |
| 删除 group | 软删，不级联 |
