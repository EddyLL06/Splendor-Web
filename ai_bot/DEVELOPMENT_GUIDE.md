# Gem Council / Splendor AI Bot 开发与交付手册

> 状态：开发前设计基线  
> 编写日期：2026-08-03  
> 适用分支：`dev` 及其后续功能分支  
> 目标读者：接手 AI Bot 的开发 agent、代码审查者、部署维护者  
> 本文中的“必须”是合并门槛；“建议”允许在有测试和记录的前提下调整。

## 0. 一页执行摘要

本项目应采用“离线调参的启发式评估 + 小宽度 beam search”的服务端 AI，不在生产服务器上训练，也不运行大模型、Java sidecar 或无上限 MCTS。

每次机器人行动的推荐流程：

1. 从机器人实际可见的 `playerView` 构造 `AIObservation`，彻底移除真实牌堆顺序和对手暗扣牌身份。
2. 枚举当前阶段可以提交的行动，包括主行动、弃筹码和贵族选择。
3. 用很轻的特征评估全部候选。
4. 普通难度直接选一层评估结果；困难难度只保留前 5 个候选，向前模拟到机器人下一回合之前；专家难度只对接近的候选做有硬上限的微型 MCTS。
5. 计算放进全服务器共享的 Worker Thread 池；默认最多 1–2 个 AI 计算 worker，不为每局或每个机器人创建 worker。
6. 超时必须返回当前 best-so-far；队列过载必须降级为便宜策略；不得阻塞 Node 主事件循环。
7. 机器人通过与真人相同的 boardgame.io 权威更新链路提交 move，不能直接写 `MemoryMatchStore` 或修改 `G`。
8. 训练只在离线 CLI 中通过自我对弈进行，生产环境只读取经过验证、带版本号的 JSON 权重。

首个可玩的版本只交付 Easy 与 Normal；Hard 在性能测试通过后开启；Expert 默认关闭，只有在证明收益大于额外负载后才进入生产。

## 1. 项目当前事实与不可破坏的边界

### 1.1 当前技术栈

- Node.js 24，`package.json` 约束为 `>=24 <25`。
- TypeScript、React、Vite。
- boardgame.io 固定为 `0.50.2`。
- Koa/Socket.IO 服务端，客户端和服务端开发端口分别为 5173、8000。
- Prisma + SQLite 只持久化账号、会话和头像等数据。
- 活跃房间和游戏状态由 `MemoryMatchStore` 保存；Node 进程重启后对局消失。
- 游戏支持 2–4 人；当前房间席位默认全部是已登录真人。

### 1.2 必须复用的权威规则

以下文件是 AI 的规则事实来源，不允许另写一套“近似规则”：

- `src/shared/types/game.ts`：`SplendorState`、`MainAction`、`PendingResolution` 等类型。
- `src/shared/rules/engine.ts`：`applyMainAction`、`applyDiscard`、`applyNobleSelection`。
- `src/shared/rules/selectors.ts`：分数、加成、贵族资格、有效费用、付款校验。
- `src/shared/rules/setup.ts`：初始状态与随机设置。
- `src/game/SplendorGame.ts`：boardgame.io move、回合结束和胜负集成。
- `src/game/playerView.ts`：隐藏牌堆和对手暗扣牌的安全边界。

AI 可以在搜索中建立轻量模拟包装，但每种模拟转移必须调用上述 `apply*` 函数，并通过差分测试证明结果与真实 boardgame.io reducer 一致。

### 1.3 现有规则中容易被误判的地方

- `takeDifferent` 必须取 3 种不同且银行中各至少有 1 枚的普通颜色；当银行中恰好只剩两种普通颜色（各至少 1 枚）时，降级为各取 1 枚（共 2 枚）。剩余颜色少于两种时没有取筹码降级。
- `takeSame` 只能取普通颜色，且行动前银行中该颜色必须至少有 4 枚。
- 玩家最多持有 3 张保留牌。
- 从牌堆暗扣只提交层级，不提交卡 ID；真实卡由权威引擎从牌堆取出。
- 行动后超过 10 枚筹码时，必须先完成精确数量的 `discardTokens`。
- 同时满足多个贵族时，必须完成 `chooseNoble`。
- 达到 15 分后要等所有玩家完成相同回合数，再按分数、购买卡数量等当前规则结算。
- `turnReady` 由规则层设置，boardgame.io 再结束并轮转回合；模拟器必须复刻这两个步骤。
- 购买允许多种合法付款组合。MVP AI 每张可买卡只生成 `analyzePayment(...).suggestedPayment`，即优先使用对应颜色、尽量保留黄金。这是明确的策略裁剪，不应把它误写成“枚举了所有付款向量”。

### 1.4 安全与公平性不变量

这些条件任何一条失败，都必须阻止合并和模型发布：

- AI 输入中不得出现真实牌堆顺序。
- AI 输入中不得出现其他玩家从牌堆暗扣的卡 ID。
- AI 可以看到自己暗扣的牌，因为真人玩家也能看到自己的保留牌。
- AI 不能使用账号 cookie、真人 seat credential 或伪造真人账号。
- Bot seat 必须是显式类型，不得依赖 `userId.startsWith('bot:')` 之类字符串约定来判断身份。
- Bot move 必须经过 boardgame.io 的活动玩家、状态版本、move 和规则校验。
- 任何调试日志、指标或错误不得输出完整状态、隐藏卡 ID、seat credential、access ticket 或服务端 secret。
- 同一个可见状态、模型版本、难度和随机种子应得到可复现的决定。

## 2. 范围、非目标和成功标准

### 2.1 本期范围

- 房主可以在未开局房间的空位添加机器人、移除机器人、修改难度。
- 真人和机器人可以混合组成 2–4 人对局。
- 支持 Easy、Normal、Hard；Expert 为实验开关。
- 支持机器人处理主行动、弃筹码、贵族选择和最终回合。
- 支持刷新、断线、观战、房间删除、游戏结束和再来一局。
- 支持纯离线自我对弈、权重调优、基准赛、负载测试和模型晋升。
- 生产运行有固定 CPU/时间/队列上限和降级路径。

### 2.2 明确不做

- 不把 RinascimentoFramework 的 Java 引擎嵌入生产服务。
- 不把训练放进网站、API 请求或生产 Node 进程。
- 不使用 LLM 选择行动。
- 不在浏览器中运行正式 AI。
- 不训练神经网络，不引入 GPU 依赖。
- 不默认进行全宽度 MCTS、无限深搜索或每局一个 worker。
- 不在本期持久化进行中的比赛、训练棋谱、排名或 ELO。
- 不让机器人创建房间、担任房主、注册账号或成为观战者。
- 不借 AI 功能顺便重构全部大厅、认证或规则代码。

### 2.3 完成后的用户体验

1. 房主创建 2–4 人房间。
2. 房主在空席点击“添加机器人”，选择难度。
3. Bot 席位显示独立图标、`Bot` 标记和难度；不会显示真人头像或连接状态。
4. 席位填满后正常开局。
5. 轮到 Bot 时，UI 经过单独的 350–650ms 表现延迟后看到正常 move、行动日志与动画。
6. AI 计算繁忙或超时时仍会走降级策略完成合法行动，不让整局卡死。
7. 游戏结束后再来一局会保留 Bot 数量、名字和难度，但生成新的模型决策种子。

## 3. 目标架构

```mermaid
flowchart LR
    UI["WaitingRoom / 房主控件"] --> Lobby["LobbyService / Bot 席位管理"]
    Lobby --> Seats["Tagged Seat Metadata"]
    Seats --> Controller["BotController 生命周期"]
    Controller --> View["boardgame.io 的过滤后 playerView"]
    View --> Obs["AIObservation + 不完全信息抽样"]
    Obs --> Pool["共享 Worker Thread 池"]
    Pool --> Legal["行动枚举器"]
    Legal --> Eval["启发式评估"]
    Eval --> Beam["Top-K / 一轮 Beam / 可选 micro-MCTS"]
    Beam --> Move["BotDecision"]
    Move --> Transport["同一 boardgame.io 更新链路"]
    Transport --> Rules["现有 applyMainAction / applyDiscard / chooseNoble"]
    Rules --> Store["MemoryMatchStore"]
    Store --> Clients["过滤后 Socket.IO 更新、日志和动画"]
```

### 3.1 推荐目录

本文所在的 `ai_bot/` 用于设计、实验说明和可发布模型清单。生产代码仍应遵守现有源码边界：

```text
ai_bot/
  DEVELOPMENT_GUIDE.md              # 本文
  experiments/                      # 未来：已提交的实验配置与小型摘要
  models/                           # 未来：经过晋升的版本化权重 JSON

src/shared/ai/
  types.ts                          # 观察、候选、预算、结果、模型类型
  observation.ts                    # playerView -> AIObservation
  hidden-information.ts             # 未知卡池与确定化抽样
  legal-actions.ts                  # 三种阶段的候选生成
  simulate.ts                       # 调用现有规则的轻量模拟状态
  features.ts                       # 特征提取与归一化
  evaluate.ts                       # 线性/事件价值评估
  policy.ts                         # Easy / Normal 策略
  seeded-rng.ts                     # 可复现 PRNG
  search/
    beam.ts                         # Hard 一轮小宽度搜索
    micro-mcts.ts                   # Expert，可选且有硬预算
  models/
    schema.ts                       # zod 模型格式校验
    default.ts                      # 内置安全回退权重

src/server/ai/
  bot-seat.ts                       # Bot 席位与公开序列化
  bot-controller.ts                 # 单个 Bot 的连接、轮次、取消、提交
  bot-coordinator.ts                # 每局生命周期、去重、stale 检查
  worker-pool.ts                    # 全服务器共享池与背压
  worker.ts                         # 只加载纯 AI 代码
  metrics.ts                        # 有界聚合指标，不含隐藏状态

scripts/ai/
  self-play.ts                      # 纯离线比赛运行器
  benchmark.ts                      # 基准赛
  tune.ts                           # 权重调优
  validate-model.ts                 # holdout 与模型晋升检查
  load-test.ts                      # 多对局并发与事件循环测试

tests/ai/
  ...                               # 单元、差分、公平性、性能测试
```

大量训练棋谱、临时权重、profile 和 benchmark 原始数据必须写入忽略目录，例如 `.local-data/ai-bot/`，不要提交到 Git。只有经过晋升的小型模型 JSON、实验配置和汇总报告可以进入 `ai_bot/`。

### 3.2 核心类型建议

类型名允许微调，但语义不得退化：

```ts
export type BotDifficulty = 'easy' | 'normal' | 'hard' | 'expert';

export type SeatIdentity =
  | {
      kind: 'human';
      userId: string;
      sessionId: string;
      avatarStorageKey?: string;
    }
  | {
      kind: 'bot';
      botId: string;
      difficulty: BotDifficulty;
      modelVersion: string;
    };

export type BotMove =
  | { move: 'mainAction'; args: [MainAction] }
  | { move: 'discardTokens'; args: [TokenCounts] }
  | { move: 'chooseNoble'; args: [string] };

export interface SearchBudget {
  deadlineEpochMs: number;
  maxNodes: number;
  beamWidth: number;
  maxDeterminizations: number;
  maxSimulations: number;
}

export interface BotDecision {
  move: BotMove;
  modelVersion: string;
  policy: BotDifficulty;
  seed: string;
  nodesVisited: number;
  elapsedMs: number;
  timedOut: boolean;
  fallbackLevel: 0 | 1 | 2;
}
```

`BotDecision` 的诊断字段只用于有界指标与测试，默认不进入公开游戏状态或客户端响应。

## 4. Bot 席位与服务器集成

### 4.1 为什么必须先改席位模型

当前 `SeatMetadata`、`LobbyService.start()` 和 `RoomRegistry.start()` 假设每个占用席位都有真人 `userId`。连接状态、5 分钟离线清理、host 转移、reclaim、角色切换和 rematch 也都围绕真人会话设计。

因此必须把席位改成 tagged union，并逐一审计这些路径：

- 创建、加入、离开、更新玩家。
- 房主添加、移除和修改 Bot。
- 真人切换 player/spectator。
- 房间开局校验。
- seat credential 签发和校验。
- Socket.IO `isAuthorized`。
- `RoomRegistry` 的在线、重连、离线与放弃超时。
- 房主离开与下一任房主选择。
- 公开 `RoomMatch` 序列化。
- 游戏结束和 `playAgain`。
- 房间删除时关闭 Bot controller 和取消 worker job。

Bot 不参与真人 presence：它在运行中应公开显示为 `bot`，不显示 `online/reconnecting/offline`，不建立放弃计时器，也永远不能成为 host。

### 4.2 房间 API 建议

新增经过账号认证、Origin 和 CSRF 校验的房主专用接口：

```text
POST   /api/matches/:matchID/bots
PATCH  /api/matches/:matchID/bots/:playerID
DELETE /api/matches/:matchID/bots/:playerID
```

请求体：

```json
{
  "playerID": "1",
  "difficulty": "normal"
}
```

约束：

- 只允许未开始房间。
- 只允许当前真人房主。
- `playerID` 必须是存在的空位；修改/删除时必须已经是 Bot 位。
- 难度必须来自固定枚举。
- 名称由服务端生成，如 `Bot 1` / `机器人 1`；请求中的任意伪造名字都忽略。
- 写操作必须进入现有 `withMatchLock(matchID, ...)`。
- 一次请求只改变一个席位，响应返回更新后的公开房间或可立即刷新房间。
- Bot 不持有真人 credential；如果内部传输需要凭据，应签发独立的 system/bot credential，并让校验逻辑只接受 `kind: 'bot'` 的对应席位。

### 4.3 推荐的 move 提交方式

**首选落地方案：服务端内部、经过认证的 loopback boardgame.io 客户端，每个活跃 Bot 席位一个连接；所有 AI 计算仍共用 worker 池。**

选择原因：当前 boardgame.io `SocketIO` 的每局更新队列、`Master.onUpdate`、playerView 广播和状态版本检查都封装在 transport 内部。loopback 客户端可以天然复用同一条队列和过滤链路，避免直接写 store、重复 reducer、漏广播或依赖 `boardgame.io/dist/cjs/master-*.js` 这种不稳定私有文件名。

实施要求：

1. 为 Bot 席位签发短期、可续签的内部 access ticket 和 bot seat credential，payload 明确标记 `role: 'bot'`。
2. ticket 只能连接 `127.0.0.1` 的当前服务，不提供给浏览器或 HTTP 响应。
3. Bot client 收到的必须是该 Bot 的过滤后 playerView；worker 输入直接来自这个视图。
4. client 仅在 `ctx.currentPlayer === botPlayerID` 且 `G.result === null` 时计算。
5. 主行动完成后如果仍有该 Bot 的 pending resolution，继续提交弃筹码或贵族 move。
6. 使用 server state `_stateID`；收到新 state 时取消旧 generation，旧 worker 结果必须丢弃。
7. game over、房间删除、rematch、服务停止时关闭连接和定时器。
8. 如直接 import `socket.io-client`，必须把它列为项目的直接、精确版本依赖，不能依赖传递依赖碰巧存在。

第 0 轮允许验证一个更轻的 direct dispatcher，但只有同时满足以下条件才可以替代 loopback：

- 使用稳定、已声明的 API，不导入带构建 hash 的 boardgame.io 私有文件。
- 与真人 socket update 共用同一个 per-match 串行队列。
- 使用 `Master` 等价的 credential、active player、stateID 和 move 校验。
- 对每个接收者调用与当前 transport 相同的 playerView/log 过滤。
- 差分和并发测试覆盖真人与 Bot 几乎同时提交时不会丢更新。

如果任一项无法证明，回到 loopback 方案；不要用“直接 `db.setState` 后通知刷新”的捷径。

### 4.4 BotController 状态机

```text
CREATED
  -> CONNECTING
  -> SYNCED
  -> IDLE
  -> THINK_DELAY
  -> QUEUED
  -> THINKING
  -> SUBMITTING
  -> IDLE

任何状态 -> STOPPING -> STOPPED
连接失效 -> RECONNECTING -> SYNCED
```

每个 controller 至少保存：`matchID`、`playerID`、`botId`、难度、模型版本、当前 generation、最后见到的 `_stateID`、正在等待的 job ID、取消令牌和连接清理函数。

去重键建议为：

```text
matchID + playerID + stateID + pending.type + modelVersion
```

同一键不得排入两次。表现延迟在确认轮到 Bot 后开始，但不要持有 server lock，也不要占用 worker。收到更新时清除旧延迟。

## 5. AI 可见状态与不完全信息

### 5.1 观察构造

生产决策链必须从 `createPlayerView(authoritativeState, botPlayerID)` 的等价结果开始。推荐在 Bot loopback client 上直接消费已过滤状态，再通过 `createObservation` 做一次结构化复制和校验。

`AIObservation` 应包含：

- 公开银行、市场、贵族、玩家顺序、当前玩家、回合和终局状态。
- 全部玩家公开的筹码、购买卡、贵族和公开保留牌。
- Bot 自己的全部保留牌。
- 每层牌堆剩余数量，不含真实 ID 或顺序。
- 对手暗扣牌的层级、来源和数量，卡 ID 保持 `null`。
- `pending`、`turnReady` 和本次决策所需的 boardgame ctx 子集。
- 从静态卡表和公开信息推导出的未知卡池。

开发环境启用断言：牌堆中的每一项必须是 `__hidden__`；对手 `source === 'deck'` 的保留牌 `cardId` 必须为 `null`。发现真实 ID 立即拒绝计算并记录脱敏错误。

### 5.2 未知卡池

每个 tier 的初始全集来自 `src/shared/data/gameData.ts`。从中减去：

- 当前市场可见卡。
- 所有已购买卡。
- 所有已公开保留卡。
- Bot 自己已知的暗扣牌。

剩下的卡同时覆盖牌堆和对手未知暗扣槽。确定化时必须随机打乱这个剩余集合，先分配对手未知槽，再按观察到的牌堆长度构造模拟牌堆；不得读取真实分配。

Normal 默认不做完整确定化，只用公开状态和未知池期望特征。Hard 默认每个候选使用 1 个确定化样本；Expert 最多 2–4 个，且总搜索仍受统一 deadline 和 node cap 控制。

### 5.3 公平性不变测试

构造两个权威状态，它们拥有完全相同的 playerView，但真实牌堆顺序和对手暗扣卡不同。在相同 seed、模型和预算下：

- `createObservation` 输出必须深度相等。
- Easy/Normal 决策必须相等。
- Hard/Expert 使用的确定化样本序列和最终决策必须相等。

这项测试比只检查 `playerView` 中没有 ID 更重要，因为它能发现旁路读取、seed 泄漏或未知池构造错误。

## 6. 行动枚举

### 6.1 统一输出

枚举器根据阶段只返回一种 move 类型：

- `pending === null`：`mainAction`。
- `pending.type === 'discard'`：`discardTokens`。
- `pending.type === 'noble'`：`chooseNoble`。

每个生成项可带内部 `actionKey` 和便宜预评分，但提交 payload 必须与现有 move 签名完全相同。

### 6.2 主行动候选

生成以下候选，并立刻用权威 `applyMainAction` 做一次验证；失败项是枚举器 bug，应在测试中报错而不是静默保留。

1. `takeDifferent`：五种普通颜色中所有 3 色组合，只保留银行中三色均大于 0 的组合；当银行中恰好只剩两种颜色时，生成这两色的 2 色组合。颜色顺序规范化，避免同一组合重复。
2. `takeSame`：银行数量至少为 4 的每种普通颜色。
3. `reserveMarket`：保留区少于 3 张时，每层市场中每个非空槽一项。
4. `reserveDeck`：保留区少于 3 张且该层牌堆计数大于 0 时，每层一项。
5. `purchase`：每个能购买的市场卡和自己的已知保留卡各一项，付款固定使用 `suggestedPayment`。

购买候选测试必须明确记录：MVP 没有枚举“有颜色却主动多付黄金”的其他合法付款方式。若未来实测证明这些方式能改善策略，再独立增加付款枚举和分支控制，不要悄悄扩大搜索树。

### 6.3 弃筹码候选

枚举六种 token color 的非负整数向量，满足：

- 每种退回数量不超过拥有数量。
- 总和精确等于 `pending.count`。

正常游戏中的 overage 很小，但实现不得依赖固定最大值。用有剪枝的递归组合生成，并为异常状态设置 `maxCandidates`；超过时先按便宜“保留目标卡所需筹码”的评价保留前 N，而不是阻塞。

### 6.4 贵族候选

为 `pending.eligibleNobleIds` 中仍通过 `getEligibleNobleIDs` 验证的每个 ID 生成 `chooseNoble`。通常贵族点数相同，评价应主要考虑稀缺性、阻止对手和后续引擎方向，不得固定选数组第一项作为所有难度的策略。

### 6.5 无候选处理

真实可达状态原则上应至少有一个候选。若没有：

- 不得提交伪造的 pass 或无效 move。
- 返回结构化 `NO_LEGAL_ACTION`，包含脱敏后的 match/player/stateID。
- controller 停止重复排队并提升错误指标。
- 保存最小可复现测试状态到仅本地的 `.local-data/ai-bot/failures/`。
- 将其作为规则层或状态一致性问题修复；若要增加 pass，必须是单独的规则变更。

## 7. 模拟器

### 7.1 `SimulationState`

```ts
interface SimulationState {
  G: SplendorState;
  currentPlayer: string;
  playOrder: string[];
  playOrderPos: number;
  stateID: number;
}
```

对候选执行：

1. 主行动调用 `applyMainAction(G, actor, currentPlayer, action)`。
2. pending discard 调用 `applyDiscard`。
3. pending noble 调用 `applyNobleSelection`。
4. 若结果失败，将其视为 AI bug；生成器不应产生失败行动。
5. 若 `G.turnReady === true` 且 `G.result === null`，轮转到下一个玩家并把新状态的 `turnReady` 设为 `false`，对应 `SplendorGame` 的 turn end/onBegin。
6. 若仍是同一玩家的 pending，不能提前轮转。
7. 若 `G.result !== null`，停止扩展。

不要调用 `Math.random()`。初始化、未知卡确定化、Easy 随机选择和同分打破全部使用注入的 seeded RNG。

### 7.2 差分测试

对固定 seed 的大量状态和每个生成行动，同时运行：

- 轻量模拟器。
- boardgame.io 的真实 reducer/测试 client。

比较 `G`、`ctx.currentPlayer`、`_stateID` 语义、pending、日志、市场补牌、终局和胜者。发现差异时优先修模拟包装，不复制或修改权威规则来“对齐 AI”。

## 8. 评估函数

### 8.1 形式

MVP 使用可解释、速度稳定的线性评价：

```text
value(state, perspective) = Σ normalizedFeature_i × weight_i
```

终局覆盖：胜利为很大的正值，失败为很大的负值，共同胜利按产品决定计分但训练报告必须单列。所有非终局特征应裁剪到稳定区间，避免分数特征完全淹没早期引擎建设。

### 8.2 最低特征集

| 组别 | 特征 | 预期方向 |
| --- | --- | --- |
| 结果 | 是否胜利、名次、终局分差 | 胜利强正，失败强负 |
| 分数 | 自己分数、领先者差距、距 15 分 | 正向，终局阶段权重提高 |
| 引擎 | 五色 bonus、bonus 均衡度、已购买卡数 | 正向但避免刷低价值卡 |
| 贵族 | 对每个贵族的剩余 bonus 距离、可立即获得 | 越接近越正 |
| 经济 | 可用筹码、黄金、下一步可买卡数量 | 适量正向 |
| 浪费 | 超过 10 前的拥挤、弃牌损失、无目标筹码 | 负向 |
| 市场 | 可买高分卡、目标卡距离、层级价值 | 正向 |
| 保留 | 保留卡可实现性、保留槽占用、黄金收益 | 有条件正负 |
| 对手 | 对手最高分、即将购卡/拿贵族、终局威胁 | 防守性负值 |
| 阻断 | 拿走对手关键公开卡的收益 | 小幅正向，不能压过自我发展 |
| 节奏 | 预计到下一分/贵族的行动数 | 越少越好 |
| 平局 | 已购买卡数的终局 tie-break 风险 | 同分时卡越少越好 |

推荐把特征计算成“自己值减去对手聚合值”。2 人局可用直接差；3–4 人局至少同时包含最高威胁对手和其余对手均值，避免只针对下一位玩家。

### 8.3 事件价值

除 state feature 外，可记录一次行动造成的事件增量：买卡、得分、获得 bonus、拿贵族、浪费黄金、迫使弃筹码、触发终局等。该思路受 Rinascimento 的 event-value 研究启发，但必须在本项目 TypeScript 规则上重新实现。

参考项目：[RinascimentoFramework](https://github.com/ivanbravi/RinascimentoFramework) 是研究用 Splendor-like Game AI 框架，包含 agent、超参数调优和相关实验，当前仓库使用 MIT License。除非确实复制代码，否则只借鉴论文/架构思想；若复制任何实现，必须先做逐文件许可审查、保留 MIT notice、列出来源，并避免把其 Java 状态模型当成本项目规则真相。

## 9. 难度与默认预算

以下是初始配置，后续只能通过基准数据调整：

| 难度 | 候选处理 | 搜索 | 计算硬预算 | 节点/样本上限 | 生产状态 |
| --- | --- | --- | --- | --- | --- |
| Easy | 便宜评分后，从前 6–8 项按 softmax/加权随机选择 | 无 | 8ms | 128 节点 | 首发开启 |
| Normal | 评估全部行动后选最高，seeded tie-break | 1-ply | 20ms | 256 节点 | 首发开启 |
| Hard | 预评分保留前 5，模拟所有对手各一次贪心回应，直到 Bot 下一回合前 | 一轮小宽度 beam | 80ms | 800 节点，1 个确定化 | 性能门槛后开启 |
| Expert | Hard 结果接近时才对前 2–3 项做 micro-MCTS | 条件式 | 120ms | 150 次模拟，最多 4 个确定化 | 默认关闭 |

说明：

- “硬预算”是 worker 内主动检查的 deadline，不是平均目标。
- 每扩展固定数量节点都检查 deadline；到期立即返回 best-so-far。
- coordinator 另设外部 watchdog，例如预算 + 50ms（至少 2s，为 worker 冷启动留出余量）。worker 无响应时终止/重建该 worker，并使用 Normal 或 Easy 回退。
- 人类观感延迟建议 350–650ms，使用 seeded 抖动；它不计入 AI CPU 预算，也不占 worker。
- 若候选很少或能立即结束游戏，允许提前返回。
- Expert 必须用功能开关；没有显著胜率收益时不值得生产成本。

### 9.1 Hard 的“一轮”定义

从当前 Bot 行动开始：

1. 完成 Bot 主行动及其所有 pending resolution。
2. 对随后每个对手，用 Normal 的快速策略选择并完成一个完整回合。
3. 到再次轮到 Bot 或游戏结束时评价叶子。

这比固定深度“2 ply”更适合 2–4 人局，也不会漏掉弃筹码/贵族子步骤。对手模型首先使用贪心 Normal；训练验证后可增加少量温度随机性，但同 seed 必须可复现。

## 10. Worker 池、背压和故障降级

### 10.1 默认池大小

推荐默认：

```text
logical CPUs <= 2: 1 worker
logical CPUs >= 3: 2 workers
配置硬上限: 4 workers
```

实现可使用 `os.availableParallelism()`，但必须保留至少一个核心给主服务，并允许环境变量进一步降低。不要默认开到 `CPU - 1`，因为同一进程还承担 HTTP、认证、Socket.IO、图片和 Vite/静态服务。

### 10.2 队列规则

- 全局有界队列，初始建议 256 jobs。
- 同一 match 同时最多一个计算 job；pending continuation 可在上一个完成后立刻排队。
- 优先级：正在被真人等待的 live game 高于离线/后台任务。生产进程不得运行训练任务。
- 排队超过该难度预算时直接降级：Hard/Expert -> Normal -> Easy。
- 队列满时不拒绝整局，使用主线程中经过严格微基准的 O(actions) Easy fallback；该 fallback 不得做搜索或大量确定化。
- worker message 必须可结构化克隆，不传函数、数据库对象、socket 或 secret。
- worker 启动时加载并校验模型一次；模型切换采用新 job 版本，不在 job 中反复读文件。

### 10.3 取消与 stale result

Worker Thread 无法廉价强制取消任意同步循环，因此算法本身必须检查 deadline 和共享/消息取消标记。无论是否真的中断，coordinator 在提交前必须重新比较：

- 当前 match 是否仍存在。
- Bot 是否仍占该 playerID。
- 当前 `_stateID` 是否等于 job 输入。
- 当前玩家和 pending 是否仍与输入一致。
- 模型版本是否仍允许提交。

任一不匹配则丢弃结果，不算错误、不提交 move。

### 10.4 建议环境变量（未来新增）

```dotenv
AI_BOT_ENABLED=true
AI_BOT_WORKERS=auto
AI_BOT_QUEUE_LIMIT=256
AI_BOT_MODEL_PATH=ai_bot/models/heuristic-v1.json
AI_BOT_THINK_DELAY_MIN_MS=350
AI_BOT_THINK_DELAY_MAX_MS=650
AI_BOT_HARD_MAX_MS=80
AI_BOT_EXPERT_ENABLED=false
AI_BOT_EXPERT_MAX_MS=120
AI_BOT_DIAGNOSTICS=false
```

这些变量必须进入 `.env.example` 和 `AppConfig` 严格校验。无效值应在启动时失败，而不是运行中静默修正。测试环境应使用显式小预算和无表现延迟。

## 11. 权重模型格式与加载

推荐 JSON：

```json
{
  "schemaVersion": 1,
  "modelVersion": "heuristic-v1.0.0",
  "createdAt": "2026-08-03T00:00:00.000Z",
  "rulesFingerprint": "sha256:...",
  "featureVersion": "features-v1",
  "weights": {
    "score": 1.0,
    "nobleProgress": 0.2,
    "engineBalance": 0.1
  },
  "training": {
    "algorithm": "random-restart-coordinate-search-v1",
    "seedSet": "train-v1",
    "games": 50000
  },
  "validation": {
    "holdoutSeedSet": "holdout-v1",
    "games": 10000,
    "baselineModelVersion": "heuristic-v0.1.0"
  }
}
```

实际 schema 应列全特征并由 zod 严格检查：禁止未知键、NaN/Infinity、缺失权重、不可接受的范围或不匹配的 feature version。`rulesFingerprint` 至少覆盖游戏数据和影响行动/结算的规则文件，防止规则变化后误用旧模型。

加载策略：

1. 启动时读取并校验指定模型。
2. 失败时在 production 直接拒绝启用 Bot，或明确回退到已编译的安全 baseline；二选一必须在配置中固定，不能静默。
3. 每局创建时锁定模型版本，避免一局中途换脑。
4. rematch 可以使用当前已晋升模型，但公开房间数据必须显示实际版本只在诊断接口中，不面向普通用户。

## 12. 本地开发启动

### 12.1 当前已经存在的命令

在仓库根目录执行：

```bash
npm ci
npm run config:local
npm run prisma:generate
npm run prisma:migrate:deploy
npm run dev
```

启动后：

- 前端：`http://localhost:5173`
- 账号、大厅、游戏和 Socket.IO：`http://localhost:8000`
- 本地数据：`.local-data/`

`config:local` 只补充被忽略的 `.env` 缺失项和随机 secret，不打印或覆盖已有值。不要提交 `.env`。开发新数据库 migration 时才使用 `npm run prisma:migrate:dev`；普通启动和拉取已有 migration 使用 `prisma:migrate:deploy`。

可单独启动：

```bash
npm run dev:server
npm run dev:client
```

### 12.2 AI 开发后的本地演示步骤

1. 在 `.env` 设置 `AI_BOT_ENABLED=true`，保留 worker 默认值。
2. `npm run dev`。
3. 在两个独立浏览器 context 中创建至少一个真人账号；如邮件未配置，开发者应使用项目现有测试/本地邮件方案，不能把 `EMAIL_PROVIDER=fake` 开放到非 test 环境。
4. 创建 2 人房间，在空位添加 Easy Bot，开局并打完一局。
5. 创建 4 人房间，配置 1 真人 + 3 个不同难度 Bot，检查连续 Bot 回合和 UI 动画。
6. 中途刷新真人页面，确认 Bot 不重复行动。
7. 游戏结束后点击再来一局，确认 Bot 配置保留且旧 controller 已停止。
8. 重启服务，确认内存对局消失，且没有残留 Bot worker/job 继续运行。

### 12.3 将来应新增的 npm scripts

以下命令目前尚不存在；对应轮次实现时再加入 `package.json`，不要在实现前误导使用者：

```text
npm run ai:self-play        # 小规模确定性自我对弈冒烟
npm run ai:benchmark        # 指定模型和 baseline 的基准赛
npm run ai:tune             # 离线调权重
npm run ai:validate         # holdout、公平性和晋升门槛
npm run ai:load-test        # 多局并发与服务负载
npm run test:ai             # AI 专属快速测试集合
```

每个脚本必须支持 `--seed`、`--games`、`--players`、`--model`、`--output` 等显式参数，并在输出 manifest 中回写全部实际参数，保证实验可复现。

脚本实现后的标准调用模板：

```bash
# 100 局快速冒烟；用于开发中发现非法行动和死循环
npm run ai:self-play -- --seed smoke-v1 --games 100 --players 2,3,4 --agents uniform-random-v1,cheap-greedy-v1 --output .local-data/ai-bot/runs/smoke-v1

# 候选模型对冻结 baseline 的正式基准
npm run ai:benchmark -- --seed validation-v1 --games 5000 --players 2,3,4 --model .local-data/ai-bot/candidates/heuristic-v1.json --baseline ai_bot/models/hand-tuned-v1.json --rotate-seats true --output .local-data/ai-bot/runs/validation-v1

# 只使用 train seed 调参
npm run ai:tune -- --seed train-v1 --games 50000 --base ai_bot/models/hand-tuned-v1.json --algorithm coordinate-search --output .local-data/ai-bot/candidates/heuristic-v2

# 使用从未参与调参的 holdout 做晋升判断
npm run ai:validate -- --seed holdout-v1 --games 10000 --candidate .local-data/ai-bot/candidates/heuristic-v2/model.json --production ai_bot/models/heuristic-v1.json --output .local-data/ai-bot/runs/holdout-v1

# 验证共享 worker、队列和主服务延迟
npm run ai:load-test -- --seed load-v1 --concurrent-games 10,25,50 --difficulty hard --duration 60s --output .local-data/ai-bot/runs/load-v1
```

参数名可在实现时小幅调整，但同一脚本一旦用于正式模型实验就要保持向后兼容，或提升 manifest schema version。标准输出目录至少包含：

```text
run-directory/
  manifest.json          # 命令、commit、Node/OS/CPU、模型 checksum、全部 seed
  summary.json           # 机器可读指标与置信区间
  summary.md             # 人类可审查结论
  failures/              # 仅失败局的最小复现，成功时为空
  profiles/              # 可选；默认不生成，不提交 Git
```

正式实验开始前先把 seed 集版本化；不要在看到结果后增删不利 seed。正式 holdout 原始结果只生成一次，后续调参必须建立新的候选版本和新的最终 holdout。

## 13. 离线训练与调参

这里的“训练”是调启发式权重和少量搜索超参数，不是训练神经网络。

### 13.1 Headless 对局运行器

必须直接调用纯规则/模拟层，不启动 Koa、Socket.IO、Prisma、浏览器或 Worker Thread。每局输入：

- 玩家数 2/3/4。
- 初始玩家和座位排列。
- 游戏 setup seed。
- 每个 agent 的模型、难度和决策 seed。
- 最大回合/行动保护上限。

每局输出至少包括：胜者/并列、最终名次、分数、卡数、回合数、每个 agent 决策耗时、节点数、超时数、fallback 数、非法行动数和 seed。训练可只保留汇总；失败局保存最小复现记录。

### 13.2 Baseline agents

先实现并冻结三个 baseline：

- `uniform-random-v1`：所有生成候选等概率，用于发现规则/枚举偏差。
- `cheap-greedy-v1`：只看立即分数、贵族、买卡和明显浪费。
- `hand-tuned-v1`：第一版完整特征的人工权重。

任何新模型必须同时对比这些 baseline 和上一个 production model，不能只做 self-play against itself。

### 13.3 第一阶段调优算法

从简单、可审计的方法开始：

1. 对特征做固定范围归一化。
2. 随机生成若干权重向量，限制每个权重范围。
3. 用小样本筛选。
4. 对前几名做随机重启的 coordinate search / hill climbing。
5. 用更大的独立 train seed 集复赛。
6. 最后只在从未参与调参的 holdout seed 上做一次模型晋升判断。

只有当简单调优明显停滞，才考虑 CMA-ES、NTBEA 或其他优化器。引入新优化依赖前必须证明它不会进入 production bundle，并记录许可证。

### 13.4 比赛矩阵

每次正式验证至少覆盖：

- 2、3、4 人局。
- 所有 seat rotation 和 first-player rotation。
- 新模型 vs 随机、贪心、上版模型。
- 同模型镜像局，用于检测座位偏差。
- 训练 seed、验证 seed、holdout seed 完全分离。
- 多个确定化 seed，防止只适应固定未知牌抽样。

2 人局胜率将共同胜利计 0.5，同时单独报告 draw rate。3–4 人局报告胜率、平均名次、平均分和最差座位表现。结论必须带 95% 置信区间；样本不足时标记为 inconclusive，不凭点估计晋升。

### 13.5 目标函数

推荐分层目标，而不是把一切揉成一个难以解释的数字：

1. 硬约束：非法行动 = 0、公平性泄漏 = 0、超出硬预算的未处理 job = 0。
2. 主要目标：相对 baseline 胜率/平均名次。
3. 次要目标：决策 p95/p99、timeout/fallback 比例。
4. 质量护栏：座位偏差、行动多样性、平均局长，防止学出循环或单一退化策略。

### 13.6 模型晋升

只有满足以下条件才能把候选 JSON 提交到 `ai_bot/models/`：

- schema、feature version、rules fingerprint 全部匹配。
- holdout 上没有显著回退；Normal 对 frozen random baseline 的 2 人局目标点估计至少 60%。
- Hard 对当前 Normal 的 2 人局目标点估计至少 55%，且 95% 区间下界高于 50%；达不到则保留为实验模型。
- 2/3/4 人所有席位没有明显系统性劣势。
- 非法 move、死循环、隐藏信息不变测试均为 0 失败。
- 在记录硬件上满足对应时间预算，报告 p50/p95/p99 和超时率。
- 模型文件、实验配置、汇总报告和 Git commit 全部可互相追溯。

这些数字是初始产品门槛，可根据真实数据改，但变更必须在实验报告中解释，不能为了让候选过关而事后降低门槛。

## 14. 测试策略与合并门槛

### 14.1 单元测试

- 每类生成候选都能被对应 `apply*` 接受。
- token 组合无重复、规范排序、边界银行数量正确。
- reserve limit、空 deck、空 market slot 正确。
- 每张可购买卡都有且只有一个 canonical payment 候选。
- discard 组合总数和内容对小状态做穷举对照。
- noble pending 只生成仍合格的贵族。
- feature 归一化、符号和终局覆盖正确。
- seeded RNG 黄金样例稳定。
- 同状态/seed/model 决策稳定。
- deadline 到达返回 best-so-far。
- 无候选返回显式错误，不忙循环。

### 14.2 属性与随机状态测试

从正常自我对弈轨迹采样状态，也生成经过约束的边界状态。至少验证：

- AI 不修改输入对象。
- 返回 move 在原状态有效。
- 模拟后 token/card/noble 总量守恒。
- 状态引用全部对应静态卡表。
- 搜索不因候选顺序变化而产生非 seeded 的漂移。
- 取消或 deadline 不导致未捕获异常。

如果引入 property-testing 库，应是 devDependency，并固定版本；不引库也可以先用现有 Vitest + seeded loop。

### 14.3 差分测试

- 模拟器 vs boardgame.io reducer。
- Bot loopback 提交 vs 真人 client 提交同一 move。
- 主行动 + discard + noble 多步骤回合。
- 市场补牌、暗扣、最终回合和共同胜利。

### 14.4 公平性与安全测试

- 相同 playerView、不同隐藏真相得到相同决策。
- worker message snapshot 不含真实 deck ID 和对手暗扣 ID。
- 公共 `RoomMatch` 不含 bot credential/access ticket/model weights。
- 真人不能 claim Bot 位；非房主不能增删改 Bot。
- Bot credential 不能用于其他 match/playerID。
- 浏览器不能调用内部 ticket 签发接口。
- 日志与错误不含 credential、secret 或完整隐藏状态。

### 14.5 服务器集成测试

复用 `tests/server-test-kit.ts` 的独立临时 SQLite、fake email 和 `createTestApplication()`：

- 房主添加/修改/删除 Bot。
- 非房主、观战者、未登录请求被拒绝。
- 真人与 Bot 混合填满后开局。
- Bot 自动完成完整回合及 pending resolution。
- 真人刷新时 Bot 不重复行动。
- 多个连续 Bot 席位按顺序行动。
- 删除房间后 controller/job 清理。
- 断开 Bot 内部连接后可恢复且不重复提交。
- 真人离开时 host 转移只选择真人。
- rematch 保留 Bot 配置并关闭旧局 controller。
- Spectator 看到过滤后的正常更新。

### 14.6 E2E

在现有 Playwright 单 worker、独立测试服务基础上增加：

1. 注册/登录房主。
2. 创建 2 人房间。
3. 添加 Easy Bot。
4. 开局，等待 Bot 行动。
5. 真人完成至少一个行动，确认下一次 Bot 行动。
6. 检查 Bot badge、难度、行动日志和没有错误提示。
7. 结束可使用测试专用确定性短局 fixture，不要把缩短胜利分数的开关暴露到 production。

### 14.7 性能与负载测试

至少记录：

- 单次决定 p50/p95/p99。
- 各难度 nodes、timeout、fallback 比例。
- worker queue wait p95/p99 和最大深度。
- Node 主线程 event-loop delay p95/p99。
- RSS/heap/每个 Bot controller 增量。
- 10、25、50 个同时轮到 Bot 的对局完成时间。
- HTTP `/api/auth/me`、大厅读取和 Socket 更新在 AI 压力下的延迟变化。

初始生产门槛：Hard worker 内 p95 不超过 80ms、未处理超时为 0；50 个突发 job 时主线程 event-loop delay p99 目标低于 50ms，队列可降级但服务不能无响应。硬件、Node 版本、模型和命令必须写进报告，不能把不同机器的数字直接比较。

### 14.8 每次 PR 的现有基础门槛

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

AI 轮次还要运行当轮新增的 `test:ai`、benchmark 或 load-test。E2E 需要已安装 Google Chrome channel。提交前检查 `git status`，只暂存本轮文件，不带入用户的其他工作树改动。

## 15. 分轮开发与预期交付

每轮都应单独形成可审查变更。后续 agent 开始一轮前先阅读本文、`README.md`、`RULES_IMPLEMENTATION.md`、相关源码和上一轮交付记录；完成后在 `ai_bot/experiments/` 或 PR 描述中记录实际结果。

### 第 0 轮：集成探针与契约冻结

目标：在不做完整 AI 的情况下证明 Bot 能安全占位、看到过滤状态并通过权威链路提交一次 move。

交付：

- Bot/human tagged seat type 草案和 public serialization 草案。
- loopback Bot credential/access ticket 的最小实现或测试 spike。
- 一局中 Bot 通过同一 Socket.IO/update 队列提交固定合法行动的集成测试。
- 证明 Bot 收到的 deck 全是 `__hidden__`、对手暗扣为 `null`。
- direct dispatcher 可行性记录；若不能满足第 4.3 节全部条件，明确采用 loopback，不继续探索私有 API。

验收：

- 固定 Bot move 出现在权威 store、真人客户端和行动日志中。
- 并发发送一个 stale action 时不会覆盖新状态。
- 无直接 `setState` 绕过规则的代码。
- 没有导入 `boardgame.io` 带 hash 的私有构建文件。

本轮预期：只证明集成路线，不追求“聪明”、完整 UI 或性能优化。

### 第 1 轮：纯 AI 内核与 Random/Greedy Bot

目标：完成可测试、可离线运行的观察、枚举、模拟和确定性基础。

交付：

- `AIObservation`、未知池、公平性断言。
- 三阶段行动枚举器。
- 轻量模拟器和 boardgame.io 差分测试。
- seeded RNG、uniform random、cheap greedy。
- headless 自我对弈冒烟脚本。
- 失败状态最小复现输出。

验收：

- 至少 10,000 局混合 2/3/4 人 seeded 自我对弈，非法行动为 0、未结束死循环为 0。
- 相同命令和 seed 的汇总 hash 相同。
- 隐藏信息不变测试通过。
- 全部现有规则测试继续通过。

本轮预期：Bot 能完整打完比赛，但策略只达到随机/基础贪心，不加入大厅 UI。

### 第 2 轮：房间、生命周期与 Easy E2E

目标：让真实用户可以创建并完成一局 Easy Bot 对局。

交付：

- Bot 席位 API、host 权限、CSRF/Origin 校验。
- `RoomMatch` Bot 公开字段和 WaitingRoom 控件。
- 中英文文案、Bot badge、难度显示。
- BotCoordinator、controller 生命周期和 loopback 提交。
- Easy 策略、表现延迟、超时安全回退。
- 集成测试和 Playwright 主流程。

验收：

- 1 真人 + 1 Bot、1 真人 + 3 Bot 都能完成对局。
- 连续 Bot 回合、刷新、断线恢复、房间删除和 rematch 无重复 move/残留任务。
- 非房主无法改 Bot；Bot 不参与真人离线清理或 host 转移。
- 全部基础门槛通过。

本轮预期：产品功能可用但 Easy 有意不稳定，不以胜率作为合并门槛。

### 第 3 轮：Normal 启发式与训练流水线

目标：以很低运行负载获得明显优于随机的策略。

交付：

- 完整 feature vector、归一化和人工 baseline 权重。
- Normal 1-ply 策略。
- self-play、benchmark、tune、validate CLI。
- 训练/验证/holdout seed 分离。
- 第一份模型 JSON、schema、rules fingerprint 和实验报告。

验收：

- Normal 对 frozen random 的 2 人 holdout 胜率点估计至少 60%。
- 3/4 人局平均名次和席位偏差报告完整，不出现明显退化。
- Normal p95 在记录硬件上不超过 20ms，超时都有 fallback。
- 模型可从 manifest 复现实验，非法行动为 0。

本轮预期：这是默认推荐难度，也是低配服务器的主要“聪明/负载”平衡点。

### 第 4 轮：共享 Worker 池与 Hard Beam

目标：把搜索计算隔离出事件循环，并在严格预算内提升强度。

交付：

- 有界共享 worker pool、优先级、背压、取消和 watchdog。
- Hard top-5 一轮 beam 和 1 次确定化。
- worker 崩溃重建、stale 丢弃和多 Bot 连续回合处理。
- 10/25/50 并发对局 load test 与报告。
- Hard 功能开关和生产默认配置。

验收：

- Hard 对当前 Normal 的 2 人 holdout 点估计至少 55%，目标为 95% 区间下界高于 50%。
- Hard worker 内 p95 不超过 80ms；超时返回 best-so-far。
- 50 个突发 job 时 HTTP/Socket 服务保持响应，队列按设计降级。
- worker 数永远不超过配置上限，房间结束后无 job/controller 泄漏。

本轮预期：Hard 比 Normal 更强，但服务器 CPU 峰值仍被 worker 数和预算严格封顶。

### 第 5 轮：Expert 实验与模型晋升

目标：判断条件式 micro-MCTS 是否值得生产成本，而不是默认上线复杂搜索。

交付：

- 仅对评分接近候选启用的 micro-MCTS。
- 150 simulation / 120ms 双上限和最多 4 次确定化。
- Expert vs Hard 的盲测、负载报告和决策多样性分析。
- 模型晋升/回滚说明。

验收：

- 只有在 holdout 显示统计可信的胜率收益、且负载门槛通过时才打开 `AI_BOT_EXPERT_ENABLED`。
- 未证明收益则保留实验代码或完全不合并；“功能更多”不是上线理由。
- 所有隐藏信息不变测试在多确定化下仍通过。

本轮预期：可能交付“Expert 保持关闭”的结论，这也是有效结果。

### 第 6 轮：生产硬化与最终交付

目标：让维护者能安全部署、观察和回滚。

交付：

- README 和 SERVER_SETUP 的 AI 环境变量、资源建议、升级/回滚步骤。
- 有界指标：决定数量、耗时分位、timeout、fallback、queue depth、worker restart。
- 日志脱敏审计。
- 模型 checksum/rules fingerprint 启动检查。
- 一键 AI smoke/benchmark 命令和发布清单。
- 最终架构与已知限制更新回本文。

验收：

- 生产构建和干净环境启动通过。
- 禁用 `AI_BOT_ENABLED` 可无数据库迁移地回退到纯真人模式。
- 删除或回滚模型不会破坏账号/真人对局路径。
- 运行手册由未参与开发的 agent 按步骤成功复现。

本轮预期：形成可部署、可关闭、可观察、可复现的完整功能，而不只是本地 demo。

## 16. Agent 每轮工作协议

### 16.1 开始前

1. 确认在仓库根目录和正确分支。
2. 查看 `git status`，记录并保护已有未提交改动。
3. 若仓库有 `.codegraph/`，先用 CodeGraph 定位符号和调用路径，再读相关文件。
4. 阅读本轮涉及的现有测试；先写失败测试或明确验收 fixture。
5. 把本轮目标、不做项和风险写进计划。
6. 不擅自 push、合并到 `main`、修改远程或带入无关改动。

### 16.2 开发中

- 规则改动与 AI 改动分开；若发现规则缺陷，单独记录并请求决策。
- 每个 worker/job 使用显式 seed 和 deadline。
- 每加入一种隐藏信息衍生特征，都补相同 playerView 不变测试。
- 每修改 seat metadata，都搜索并检查 join/leave/start/reclaim/role/rematch/socket/public serializer。
- 每修改模拟转移，都跑差分测试。
- 每增加依赖，说明运行端还是 dev-only、体积和许可证。

### 16.3 交付说明必须包含

- 本轮实际完成与未完成。
- 改动文件列表和架构决策。
- 执行过的命令及结果。
- benchmark 硬件、Node 版本、seed、games、模型和完整参数。
- 胜率/名次的样本量与置信区间。
- p50/p95/p99、timeout/fallback/illegal move。
- 已知风险、下一轮入口和回滚方法。
- 是否改变模型、规则 fingerprint、数据库或部署配置。

## 17. 可观测性与隐私

推荐聚合指标名：

```text
ai_decisions_total{difficulty,outcome}
ai_decision_duration_ms{difficulty}
ai_queue_wait_ms{difficulty}
ai_queue_depth
ai_timeouts_total{difficulty}
ai_fallback_total{from,to}
ai_worker_restarts_total
ai_stale_results_total
ai_no_legal_action_total
```

日志可以包含：match ID 的不可逆短 hash、playerID、难度、模型版本、stateID、耗时、节点数、timeout/fallback 原因。

日志禁止包含：完整 `G`、牌堆或未知池 ID、对手暗扣 ID、所有候选细节、access ticket、seat credential、session ID、账号邮箱、secret。调试 replay 只能写入本地忽略目录，并显式打开；生产默认关闭。

## 18. 主要风险与预案

| 风险 | 早期信号 | 预案 |
| --- | --- | --- |
| 绕过 boardgame.io 导致状态竞争 | 重复回合、stale 覆盖、客户端不同步 | 采用 loopback 权威链路；stateID + per-match queue |
| 隐藏信息泄漏 | 更换真实牌序会改变同 playerView 决策 | worker 只接收 observation；不变测试阻断合并 |
| AI 阻塞服务器 | auth/lobby 延迟随 Bot 行动激增 | 共享 worker、硬 deadline、有界队列、降级 |
| Worker/房间泄漏 | 游戏结束后 RSS/job 数持续增长 | controller 状态机、统一 stop、生命周期测试 |
| 模拟器与规则漂移 | AI 认为合法但服务拒绝 | 每次规则变更跑差分测试和 rules fingerprint |
| 权重过拟合 | train 高胜率、holdout 回退 | seed 隔离、冻结 baseline、席位轮换、置信区间 |
| Expert 成本无收益 | CPU 翻倍但胜率区间重叠 | 默认关闭，允许得出“不上线”结论 |
| Bot 侵入认证模型 | bot 账号出现在用户/host/reclaim 中 | tagged union，不创建 User/Session 记录 |
| boardgame.io 0.50.2 私有 API 不稳定 | 升级后 import 路径带 hash 变化 | 不依赖私有 chunk；用公开协议/本地 adapter 契约 |

## 19. 最终 Definition of Done

只有全部满足，AI Bot 才算完整交付：

- 房主能管理 Bot，真人权限和观战流程无回归。
- Easy/Normal/Hard 能完成 2/3/4 人混合对局和所有 pending resolution。
- Bot move 走权威链路，客户端更新、日志和动画与真人行动一致。
- 10,000+ seeded 规则冒烟无非法行动/死循环；正式模型有独立 holdout 报告。
- 隐藏信息不变测试和日志脱敏审计通过。
- Worker、队列、deadline、降级和清理经过并发测试。
- `typecheck`、Vitest、build、Playwright 和 AI 测试全部通过。
- 生产默认资源上限明确；Expert 默认关闭或有证据开启。
- 模型带 schema、版本、规则 fingerprint、训练/验证 manifest 和回滚版本。
- README、部署说明、本文和实际命令一致。
- 禁用 AI 后项目能继续作为纯真人游戏正常运行。

## 20. 下一位 agent 的第一个动作

不要直接开始写搜索算法。先执行第 0 轮：

1. 用 CodeGraph 重新确认 `LobbyService.start/playAgain/join/leave`、`SeatMetadata`、`RoomRegistry`、`AuthenticatedSocketIO` 和 `MemoryMatchStore` 的最新代码。
2. 写 Bot/human tagged seat 的类型和影响清单。
3. 做一个不会直接写 store 的 loopback move spike。
4. 先证明 playerView 公平、状态版本正确、广播正常，再进入第 1 轮纯 AI 内核。

这个顺序能把最危险的集成与公平问题提前解决；后面的启发式、训练和搜索都可以在纯函数与离线 CLI 中独立迭代。
