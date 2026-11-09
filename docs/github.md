# GitHub 接入

当前实现为 github.com REST 轮询，使用专用机器账户 PAT。飞书已延期，不影响 GitHub 或其他模块。

## “通过 GitHub 接需求”是什么

例如允许名单里的维护者在目标仓库 Issue 或 PR 的正文/评论里写：

```text
@team-agent 请修复登录接口对空手机号返回 500 的问题。
范围：只改参数校验；验收：空值返回 400，正常登录不受影响，并补回归测试。
```

流程是：**GitHub 讨论 → 后台 REST 轮询（默认 60 秒）→ 持久 Trigger → 来源/授权检查 → Router 接单或关联已有工单 → Worker 执行 → Router 经 Outbox 回复原讨论**。需要你做决定时也在原讨论提问；后续消息可进入已订阅工单。启用全量观察时，未 @ 的事件按准入和主动规则评估，不直接变成任意执行任务。

这是需求和反馈渠道，不是把 GitHub 仓库所有代码自动当任务。轮询不需要公网 webhook；服务主机需要能访问 GitHub API。代码推送、draft PR 和人工合并是后续独立步骤。

代码在 GitLab 时，可使用本地工作区通过 Pi/Web 派单，详见 [GitLab 使用方式](gitlab.md)。GitLab Issue/MR 原生渠道尚未实现。

## 配置与凭证

先初始化、启动服务，在 Web“来源”页保存 GitHub 设置：

```json
{
  "enabled": true,
  "repository": "owner/repository",
  "botLogin": "your-agent-account",
  "allowedActors": ["maintainer-login"],
  "allowedBots": ["dependabot[bot]"],
  "pollSeconds": 60,
  "observe": {
    "issues": false,
    "pulls": false,
    "comments": false,
    "ci": false
  }
}
```

设置位于版本化配置的 `github` 字段，凭证不进入配置 JSON。服务读取实例目录 `github.token`，或显式环境变量 `PI_SUPERAGENT_GITHUB_TOKEN`（优先）。保护文件权限：POSIX 使用 0600；Windows 使用仅运行账户可读的目录 ACL。`admin.token` 只用于管理 API，不能用作 GitHub PAT。

机器账户细粒度 PAT 限定单一仓库：

| 用途 | GitHub repository permissions |
|---|---|
| 仓库与提交读取 | Metadata、Contents：Read |
| Issue/PR 讨论和回复 | Issues、Pull requests：Read and write |
| Check run、commit status 读取 | Checks、Commit statuses：Read |
| Git HTTPS 推送（若选择 PAT 推送） | Contents：Read and write |

`botLogin` 必须与 `/user` 返回的凭证持有人一致。GitHub App installation token 和 Enterprise 端点当前不支持。仓库与机器账户身份首次保存后固定；更换它们应创建新实例，禁用使用 `enabled: false`。

本地 Git 仓库应对应配置的远端。Git 推送凭证由管理员单独配置；默认 Git 全局配置为 `INSTANCE/agent/home/.gitconfig`，不读取系统/个人全局配置，不自动选择个人 SSH key 或 SSH agent，也不把 REST PAT 写入 Git 配置。Worker 的 HOME、GH_CONFIG_DIR 等指向实例目录，后台命令仅继承基础环境及代理/CA 设置；`job_start` 拒绝直接执行 `gh`。结果通过 `superagent_report` 交给 Router，由受控 Outbox 发布。只给运行账户提供目标仓库权限。

## 接收与授权

- 默认接收发给机器账户的提及，以及已有工单订阅讨论的后续消息。
- `observe` 开关额外接收未提及机器人的 Issue、PR、评论/Review 和默认分支 CI。
- `allowedActors` 中的真人提及机器账户属于 explicit 请求，在全局 `observe` / `off` 模式下也可执行。
- 未列入名单的人的新请求默认忽略；管理员可以在 `admission` 中逐类开放。`allowedBots` 中的机器人始终最多为 inferred，其他机器人不能创建任务。
- 准入表各行是 `issues`、`pulls`、`comments`、`ci`。默认 `listedUnaddressed: "inferred"`、`unlistedAddressed: "ignore"`、`unlistedUnaddressed: "ignore"`；仅 `unlistedAddressed` 可另设为 `"explicit"`。例如 `"admission": {"issues": {"unlistedAddressed": "inferred"}, "ci": {"unlistedUnaddressed": "inferred"}}`。默认分支 CI 要同时启用观察和对应准入，再经过规则评估。
- 已有非 context-only 工单的跟进按上游规则判断：名单内真人为 explicit，其他真人在主动模式非 off 时最多为 inferred；直接请求仍遵循准入表。
- inferred 候选需要逐条评估所有启用规则，并提供实施意图、明确目标、证据。`observe` 仅记录 `Decision.audit.would_accept`；`auto` 才创建工单；`off` 不评估主动候选。不能通过 attach 绕开推断评估。
- Subscription 带来上下文，不扩大原 Mandate。context-only 订阅不授予跟进权限，Worker 对超范围消息使用 handback。关闭全量观察不会撤销仍监听 Thread 的既有授权；来源禁用、准入降级、规则禁用等分别复验。显式 follow-up 授权按上游语义保留，不因后来移除发送人而失效。

全局暂停仍收取 GitHub 事件，暂停新派发和后续回复。禁用 GitHub 停止网络操作；再次启用从新的启用时刻读取。已订阅 PR 的状态会重新核对。

## 事件与恢复

轮询新建/更新的 Issue、PR 描述、Issue/PR conversation 评论、inline review 评论、review 决定。PR 与默认分支 CI 使用 check runs 和 commit statuses，失败集合变化与确定的恢复形成事件；空列表或仍运行的检查不视为恢复。

事件 ID 包含仓库和源对象身份，并按类型区分「哪些字段算身份」：

| 对象 | 身份包含 | 编辑后的行为 |
| --- | --- | --- |
| Issue / PR 正文 | 仓库 + 编号 | 仍是一条请求；正文被编辑不会重复派单（避免同一编号出现两个互相冲突的请求被不同评估取走） |
| 会话评论（`issues/comments`） | 仓库 + 评论 id + 更新时刻 + 文本 | 编辑会产生新事件，重新进入准入与评估 |
| Review 评论（`pulls/comments`） | 同上（含 `submitted_at`） | 同上 |

轮询使用 `sort=updated&since=<游标-5s>`：正文编辑让条目重新出现在结果里，但只有上面标为「新事件」的类型才会被当作新输入，因此编辑 Issue 正文不会重复派单，而编辑评论不会丢失。来源过滤自己的评论，正文里的伪造 HTML 标记不影响入站身份判断。

各流分页读取后提交游标，重叠五秒；失败不推进该流，已提交的其他流可以继续。数据库保存启用时间、游标、待补读 PR、CI 修订和健康状态。重启后读取这些记录。限流遵守 Retry-After/重置时间，其他错误指数退避。单页 8 MiB、每流 100 页/32 MiB 上限；超限保留游标并显示错误。

## 回复和 PR

接单时 Router 可提供具体 acknowledgement，也可按匹配规则保持静默；服务不再生成固定确认。Worker 的问题、阻塞与结果持久通知 Router，由 Router 根据团队约定和匹配规则决定外发。问题必须原样转达，普通进度留在内部，dropped 默认不通知。人工跟进同时送 Worker 和 Router，Router 可按人的请求停止工单。

消息进入持久 Outbox，网络调用在事务之外执行。同一工单/对话的回复在前序重试期间保序；前序连续失败三次后升级为人工事项，并允许后续消息继续。背景结束/设置通知持久写入 Router Session，不触发模型轮次。

回复携带实例和消息 ID 派生的 HTML 标记。重试先分页检查同一机器账户已发出的标记，处理“GitHub 已提交但响应丢失”的情况。Inline 评论回复到其 review 根讨论；根评论 404/410 时回退到 PR conversation。权限丢失保留重试，锁定讨论或发送返回 410 时记录 dropped。

Worker 分支固定为 `pi-superagent/TICKET_ID`：

1. 在 Mandate 授权范围内实现并验证变更，用管理员配置的 Git 凭证推送该分支。
2. `superagent_github_create_pull` 创建或复用该机器账户、该分支的 draft PR，默认目标为仓库默认分支。该工具不推送、不合并。
3. 对已有 PR 使用 `superagent_github_bind_pull`。只能绑定工单来源 PR，或本仓库中由机器账户从精确工单分支创建的 PR；不能抢占其他活动工单的 PR。
4. 绑定完成后再报告 ready。工单保留为等待 PR 合并/关闭，来源观察到终态后再结束。

同一工单分支已存在的 PR 会被复用（包括返回其已关闭事实），不会自动重新打开已关闭 PR。需要独立新 PR 的工作使用新工单。

## 管理与诊断

CLI：`sources`、`github poll`、`decisions`、`triggers`、`threads`、`diagnostics TICKET_ID`。Pi 插件提供来源/记录/诊断查询。Web 默认列出待回答、待审阅、受阻/失败与未完成评估，支持直接回答、重试、重新评估及忽略提示；连续三次来源故障才升级到人工事项。另提供来源配置和健康、工单筛选、事件/Decision/Trigger/Thread 浏览、最近 30 条会话消息和最近 20 个后台任务的有限输出。

`403/404`：检查 PAT 仓库授权、细粒度权限、账户身份和仓库是否可见。`429`：按健康状态中的 nextPollAt 等待。缺少凭证时健康状态明确报错，不使用个人默认 GitHub 登录兜底。

模型通过 `superagent_read` 按需读取原始 Issue/PR、conversation 评论、Review 与 inline 讨论，沿 `next_offset` 翻页；每个文本页最多 4000 字符，GitHub 列表每页 20 项。Worker 只可读取本工单及其关联 Thread。管理 API 的 Thread 退订入口是 `DELETE /api/v1/threads/:key/subscriptions`；旧的 Ticket 退订地址返回更正提示。

## 验证边界

本地测试覆盖真实 HTTP 客户端分页/认证/重定向、模拟 GitHub 事件与断线重试、真实 Pi SDK Router/Worker 闭环、重启去重和 Chrome 操作。

2026-11-03 真实 Issue #1 联调：机器账号身份、读取、克隆、轮询和 Outbox 接单评论写入通过。修正 SDK 导入覆盖 Node 代理初始化的问题后，订阅接口拒绝 `gpt-5.5`；从认证后的模型列表选择 `openai/gpt-6.1-sol`，Router/Worker 已实际调用该模型并读取 README。

首次完整验收失败：Worker 使用本机 `gh`，结果误以日常个人账号发布，而非由 Router 经机器账号 Outbox 发布。当时已暂停并关闭服务，原评论保留。随后补实例 HOME/配置目录、命令环境白名单、直接 gh 调用拒绝和回复路径指令，249 项测试、直连/代理离线 SDK 集成及浏览器通过；本机只读检查确认隔离环境下 gh 无可用登录。

同日经用户授权重测通过：通过管理 API 向原 GitHub 工单发送“重测”跟进，Worker 重新读取 README，并经报告通知 Router；Router 使用 `superagent_reply` 的 result 路径，Outbox 状态为 sent。远端核验结果评论作者为专用机器账号，正文为三句话，持久投递标记与本机收据匹配。本轮没有 gh 代发。服务重启并再次轮询后，评论仍为 3 条、工单 1 个、Assignment 2 次，没有重复回复或重复执行。当时测试服务已恢复单 Worker 派单。

本地仓库与 worktree 均无变更，远端仅 main 且仍为初始提交，无 PR。GitHub 渠道的新人工跟进、stop、真实推送与 PR 生命周期继续验收。
