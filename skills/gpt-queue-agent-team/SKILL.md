---
name: gpt-queue-agent-team
description: 对可并行的长任务主动尝试使用 ChatGPT 队列多对话协作。普通聊天和项目聊天都可组队，支持非 Git 调查或 Git 独立工作树、消息 ACK 和主对话整合；只有浏览器扩展在线时才可执行。
metadata:
  short-description: 队列通信驱动的 Git 多智能体开发
---

# GPT Queue Agent Team

目标：**长任务主动评估 + 值得时并行 + 双向通信 + 结果整合**。开发任务再加上 Git 隔离与 CodeReviewFix。这是 ChatGPTTaskQueue 插件的能力，不是脱离插件的通用代理提示词。

## 使用时机（自动路由）

- 新任务含至少两项真正独立、能并行推进的工作流，预计节省的时间大于协作成本：主动检查插件是否可用，成功后建立 2～4 个子对话。
- 单一文件修改、纯问答、简单整理、必须严格串行的任务，以及用户明确说不要多智能体时：直接单对话完成。
- 没有主 ChatGPT 对话的正式 URL、无法调用本机终端或 doctor 离线时：不启动协作、不误报已分派，但继续尽可能完成原任务。
- 全局 Codex 主动协作开关由 `node skills/gpt-queue-agent-team/team.cjs install-auto` 管理；它只维护 `%USERPROFILE%\.codex\AGENTS.md` 的标记区域，执行时仍需通过下面的在线门槛。

## 0. 强制激活门槛

**每次调用本 Skill 的第一步**：通过 PCC 或 HomePC2 在电脑终端执行：

```powershell
node "$env:USERPROFILE\.codex\skills\gpt-queue-agent-team\team.cjs" doctor
```

- `doctor.ok !== true`：**禁止调用本 Skill 的 spawn/send/ack/init/协作流程**；说明浏览器扩展不在线或未配对，按普通单智能体任务执行或提示用户启用扩展。禁止用裸 HTTP、数据库、直接发浏览器按键等方式绕过门槛。
- 启用条件：插件本体文件存在、本机桥接器健康、已经绑定浏览器扩展 ID、**最近 120 秒有真实扩展目标同步**。仅本机服务运行不算插件在线。
- 本 Skill 由插件仓库安装为 Codex Skill 目录链接；不覆盖原有 `agent-team` 或任何其他 Skill。不应复制出独立维护版本。

以下示例在 ChatGPTTaskQueue 源代码仓库目录执行，也可以使用已安装 Skill 中的 `team.cjs`。

## 1. 开工：主智能体是协调者

1. 读取关联 Skill；开发任务还应读取项目 AGENTS.md、Git 状态。确定可并行模块、依赖、接口和完成标准。简单线性工作**不拆队**。
2. 最便捷的范围自动推断：`node skills/gpt-queue-agent-team/team.cjs init --auto --run <唯一短ID> --lead-chat <主智能体真实对话URL> [--repo <开发仓库路径>]`。它会识别**普通聊天**或**项目聊天**，成员始终在对应范围。原有显式 `--project <项目名称>` 和新增 `--personal` 也可使用。没有主智能体接收地址不得生成子智能体。
3. 先找出 2～4 条真实独立工作流，尽早并行 `spawn`（独立新对话 + 后台标签，不抢占原标签），各自明确责任、交付物与接收消息地址。非开发任务允许不指定 Git 仓库，但不能在未知工作区写文件。
4. `sync --run <ID>` 取得成功创建的对话 URL 并自动登记成员。**创建请求的 pending/waiting 不是创建成功**；在成员尚无真实对话 URL 前，禁止代表该成员发送消息或确认 ACK。
5. 主智能体不和子智能体写同一个文件：专注统筹、消息转发、交叉审查、验证与整合；有 Git 仓库时再执行提交。子智能体模型不高于主智能体，按实际任务合理减少数量。

## 2. 沟通是必经路径

**禁止只在结束时汇报。** 以消息 ID 为线程，在以下节点必须主动向受影响成员发送消息：

| 时刻 | 类型 | 最少包含 |
| --- | --- | --- |
| 接到任务 | `PLAN` | 本轮所有权、依赖、预期接口 |
| 发现根因/边界 | `DISCOVERY` | 证据、路径、影响的其他成员 |
| 变更接口/数据契约 | `CONTRACT` | 旧/新契约、兼容面、待确认人 |
| 阻塞/冲突 | `BLOCKER` | 复现、需要谁决定、备选路径 |
| 代码完成 | `READY` | 提交/改动、验证证据、审查请求 |
| 发现缺陷 | `REVIEW` | P0/P1/P2、具体证据、修复责任人 |
| 修复并复测 | `VERIFIED` | 测试结果、缺口、可否集成 |

- 用 `send --run <ID> --from <成员> --to <成员> --type <类型> --text <简短事实与请求>`，**直接发给受影响者**；确实无法定位时交给主智能体转发。普通团队消息使用每位成员专属后台通信标签，后续消息复用，不按消息数量反复开新标签；真正的用户普通新任务仍维持每任务独立新页。
- 收到需要处理的消息后使用 `ack --run <ID> --from <接收者> --message <消息ID> --text <接受/异议/下一步>`。ACK 会写入本机登记，并尽量把确认消息排入原发送者对话。**ACK ≠ 已解决**，仍需随后发 `VERIFIED` / `READY`。
- **队列状态 `queued` 仅代表已经保存待发；不代表对方阅读、响应，更不代表意见一致**。只有对端显式 ACK 才能记录已知晓。每次契约变化都追踪对应 ACK；超时、未送达、目标不明时，不猜测成功，不盲目重发，向主智能体升级。
- 频繁的是**有用信息**而不是刷消息：同一结论合并，关键事件即时发送；不做无意义定时聊天。
- 小队动态扩展：独立模块足够才 spawn；任务关闭或阻塞需主动告知依赖者，任何成员都可先发现、先通知，不等领导逐层传话。

## 3. 消息示例和命令

```powershell
# 首先 init --auto --run liquid-01 --repo <Git仓库> --lead-chat <主聊天URL>
# 创建项目子对话（不会重复开页；成功后用 sync 注册成员）
node skills/gpt-queue-agent-team/team.cjs spawn --run liquid-01 --member gas --role implementer --task "独立实现气体管网；只负责 GasNetwork 相关文件，先与 liquid 确认数据接口"
node skills/gpt-queue-agent-team/team.cjs sync --run liquid-01

# 点对点通信；默认普通队列=新后台标签，不使用接收方当前工作页
node skills/gpt-queue-agent-team/team.cjs send --run liquid-01 --from gas --to liquid --type CONTRACT --text "气体流量接口已冻结为 TryTransferGas(moles, temperature)；请确认"

# 接收方确认（带消息 ID、回复原成员）
node skills/gpt-queue-agent-team/team.cjs ack --run liquid-01 --from liquid --message <消息ID> --text "确认接口；液网不会依赖气体内部存储"

# 查询通信回执、成员聊天地址、未 ACK 信息
node skills/gpt-queue-agent-team/team.cjs status --run liquid-01
node skills/gpt-queue-agent-team/team.cjs inbox --run liquid-01 --member liquid
```

如需对**正在运行的旧对话**插话，仅对明确允许中断的目标使用 `send ... --mode steer --urgent`；这是原标签直接引导。不要默认使用 steer，更不能向其他项目未知会话发消息。

## 4. Git 工作分离和审查

- 推荐每个实际开发成员使用单独 `git worktree` 和分支：`agent/<run>/<member>`。主智能体负责创建、分配、回收和合并；不同 worktree 也要约定文件/接口所有权。示例：`git -C <仓库路径> worktree add -b agent/liquid-01/gas <隔离目录> HEAD`。把隔离目录及负责文件明确写进 spawn 的 `--task`；未分配 worktree 的成员只调查、不修改共享代码。
- 调查、需求梳理或非代码任务允许没有 Git 仓库。成员发送 `READY` 时用明确的结论、来源和待核验事项替代 commit SHA；主智能体仍负责核对与最终整合。
- **契约先确认**：跨模块接口写入前把 `CONTRACT` 发送给依赖成员，收到 ACK 后才进行破坏性联动。独立不受该接口影响的任务可继续并行。
- 工作结果使用明确 commit SHA + 测试命令/输出发 `READY`；复查者独立 CodeReviewFix，发现问题立即发 `REVIEW`，开发者修复后发 `VERIFIED`。
- 主智能体审计未 ACK / 未解决的重大阻塞，确认所有依赖收敛才集成；不使用 `git reset --hard` 清除其他成员工作；不强制推送。
- **任务验收后释放成员后台聊天标签**：只有所有成员 `READY`/`VERIFIED` 获主智能体 ACK、所有消息和 ACK 回执已经确认为入队、Git 集成和测试完成，主智能体才调用 `node skills/gpt-queue-agent-team/team.cjs finish --run <ID> --verified`，随后执行 `sync`/`status` 检查结果。关闭只针对插件自建、没有未完成回复、没有草稿且未被用户访问过的后台标签；不删除聊天历史，不关闭用户窗口。**不能提前 finish 或通过 finish 绕过未确认的协作消息。**
- 测试未执行或受 Unity PlayMode/Edge 环境限制，必须如实说明。依项目 Git 规范只提交本任务改动；除非用户要求，否则不推送发布。

## 5. 交付

主智能体简洁汇报：**成员/模块进展｜关键消息与 ACK｜CodeReviewFix｜测试｜Git commit｜窗口释放状态｜剩余风险**。如果队列在线但接收方没有 ACK，只能标记“已排队待确认”，不可宣称已完成跨智能体协作。

> 队列通信与本地 ACK 登记是可追踪的异步工作流，不能凭 `queued` 推断其他 AI 已理解并执行；缺乏可读回复内容时依赖对端主动回执。服务与插件关闭后，本 Skill 必须停止发起新协作。
