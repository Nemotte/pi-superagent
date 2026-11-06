# 对齐开源原型的监督与本地沟通流程

## 决定

依据 `docs/research/2026-11-04-upstream-product-ux-audit.md` 与上游 `docs/005-panel.md`，按用户要求直接落实对齐，不另拆实施计划或重复审批。基线为公开原型的功能与交互；领域 core 和 `upstream/` 保持不变，DSH 宿主能力在 Pi 适配层实现。

直接复用 DSH React 面板会引入其 Session、Provider、Cordis UI 和模型目录依赖；继续零散追加按钮则保留流程断点。本轮采用共享服务端展示模型、模块化 Web 交互和简明 Pi 命令输出，沿用上游概念、状态分类、关联导航和按状态操作规则。

## 对齐范围与验收

- [x] 统一就绪状态：未配置模型、暂停、需要处理、可派单分别展示；首页明确下一步，不用空人工事项代表健康。配置存在不宣称模型调用验证成功。
- [x] 执行详情：使用 core 的 `ticketStage/canRetry`，显示结果、授权、输入、分派记录；详情轮询不丢失输入焦点、草稿或正在执行的操作。
- [x] 本地沟通：持久展示本工单收到的输入和 Router 回复，按时间和稳定 ID 排序分页；pending/sent/dropped 明确，隔离其他工单和 context-only 输入。手工跟进仍经现有 Runtime 授权路径。
- [x] 输入/评估/会话：请求未接单也能找到，显示等待/过滤/评估/已关联工单及原因；从请求和 Decision 导航到工单或 Thread，Thread 有分页时间线。
- [x] 设置：Router/Worker 独立模型表单及固定 SDK 型号目录、最大并发、主动模式、规则、团队约定；保存按字段做三方比较，非冲突字段保留远端修改，冲突保留本地草稿并要求用户选择；不自动覆盖或恢复派单。
- [x] 保存历史及检索：有界版本历史和跨请求/工单/会话搜索，JSON 退到诊断层。
- [x] Pi：状态/提交/列表改为人可读摘要；已绑定实例有直接模型设置入口，不重选工作区，不修改身份；模型认证仍经固定 SDK 子进程和用户确认，probe 一次且显式确认。
- [x] Chromium/API/插件回归及完整 verify，确认 core、upstream 未修改。

本轮不把原型所有宿主能力一并宣称完成：完整提示词模板/技能覆盖编辑、默认版本升级合并、DSH preset/嵌套子 Agent 等需要单独 Pi 适配；后续对齐项继续记录在状态文档。

## API 与数据

新增只读管理投影，使用现有认证、Host/Origin/CSRF 和 local 写保护：

- status 增加 readiness；原字段兼容。
- Ticket 详情增加 actions、latestReport，提供分页 conversation；不将 Agent 私有推理会话当用户消息。
- requests 提供持久 Trigger 与 disposition/Decision/关联工单；threads/:key 提供分页输入、Decision 和订阅信息。
- models 经固定 SDK 子进程读取元数据，单飞缓存、10 秒超时、停止服务时取消；无认证/probe 操作。
- config/history 提供有界版本快照；search 按普通文本/ID/已保存 URL 匹配，查询参数有界，不解释用户 SQL/路径。

不改变数据库 schema，不合成业务已发送/已完成事件。展示只读取既有持久事实。新服务 API 需显式重启后生效，不替用户重启、配置模型或恢复真实实例。

## Web 状态与交互

导航按总览、来源、输入、评估、执行、设置组织；工作区保留为独立扩展视图，原始事件为次级诊断。工单详情分为即时状态与操作、沟通、结果、授权/分派等可展开信息。持久消息使用 textContent，外链仅 http(s)，任何模型文本不能变为 HTML。

轮询只更新只读区域，表单 DOM 与重试 ID 留在内存；同工单刷新保留草稿，不对用户正在输入的表单重新赋值。切换工单的迟到响应不能覆盖当前工单。未确认提交和跟进手工重试复用 ID，无自动重发；不把任务正文/凭据写进浏览器持久存储。

设置保存失败不清草稿。刷新配置仅在显式放弃或保存成功时更新；发生并发修改时比较 base/local/remote 的编辑字段，冲突不写。凭据不进入 Web 配置或模型输出；认证继续由 Pi 私密交互完成。

## GitHub 与 GitLab

代码工作区和接收需求的渠道分开：GitLab/self-hosted GitLab 仓库的本地 checkout 可使用本地来源，不要求 GitHub 账号、PAT 或迁移远端。现有执行仍使用隔离 worktree，不改变特定项目原地执行约定。

GitHub 来源在已配置单仓库轮询 Issue/PR/评论/Review/CI，将事件转 Trigger；来源范围和发送者授权先过滤，Router 决定接单/关联/忽略，Worker 在 Mandate 范围执行，Router 经 Outbox 回复原讨论。默认允许名单内真人 @ 专用机器账号发起明确请求。推送、PR 创建与合并是独立权限/步骤。

GitLab Issue/MR 原生接入尚无适配。本轮文档和 UI 如实标识；后续按上游 Source/Channel 扩展点添加 host/project 身份、原生用户授权、Issue/MR/discussion、游标去重、回复幂等与 MR 生命周期，不把改 GitHub URL 当作支持，也不要求公网 webhook。

## 验证约束

测试实例与临时仓库，不调用真实付费模型，不读取或复制真实凭据、不向 GitHub/GitLab 发布；不触碰业务项目的配置、源代码或任务。无独立 reviewer 工具，执行内联审查。

验证结果：`npm run verify && npm run test:web` 全部通过，42 个文件 / 365 项 Vitest，真实 SDK 直连/代理/多仓库、tarball 干净安装（含实际 SDK 型号目录读取）及四组 Chromium。新浏览器回归覆盖就绪、目录、旧服务资源升级提示、持久沟通/动态状态/焦点与草稿、关联检索、设置冲突与历史、详情迟到响应、跟进丢失响应同 ID 重试、回执入口分页复位。桌面和 390px 移动视口截图已检查，无横向溢出。静态脚本语法检查通过，core 差异检查及 upstream 工作树/暂存区检查均无差异。
