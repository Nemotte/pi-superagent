# GitLab 仓库如何使用

## 代码仓库与需求渠道分别配置

GitLab 仓库的本地 checkout 可以作为执行工作区。当前的本地派单不读取 GitHub，也不要求 GitHub PAT；代码继续保留在原 GitLab 远端。

使用流程：

1. 在本地应用工作区连接实例。已绑定实例直接沿用；首次使用运行 `/superagent setup`。
2. `/superagent models` 配置 Router / Worker 和必要的实例认证；自行确认是否验证模型、恢复派单。
3. `/superagent request 描述目标、范围和验收条件`，或 Web“执行”页提交。
4. 未接单请求在“输入”页查看；接单后在工单里查看 Router 回复、补充要求和回答问题。
5. 在“仓库变更与验证”查看各仓库修改和检查证据，之后按团队流程审阅、提交和发布。

Worker 使用隔离 worktree，从已提交 HEAD 开始，不复制原目录未提交文件，也不会自动推送或建立 GitLab MR。若项目约定原地执行，需要另行适配执行方式，不能直接套用此模式。

## 在 GitLab Issue / MR 里派单

公开 DeepSeek 原型提供 GitHub 和飞书来源；当前 Pi 实现提供本地和单仓库 GitHub 来源。**GitLab Issue/MR 自动接收、讨论回复、Pipeline 和 MR 生命周期尚未接入。** 把 GitHub 配置中的 URL 换成 GitLab 地址不可用。

原生 GitLab 接入应作为独立 Source/Channel 适配：

- 明确 GitLab.com 或自建站点、项目 ID、专用机器人身份和实例独立凭据。
- 将 Issue、MR、Note/Discussion、Review 和 Pipeline 转换成稳定 ID 的 Trigger/Thread。
- 保留接收范围、发送者允许名单、明确请求与推断候选的区别，不因可读仓库而自动获得执行授权。
- 轮询游标持久化、重读去重、编辑版本、限流与失败恢复。
- Router 通过 Outbox 回复到原 Issue/MR/Discussion，处理发送成功但响应丢失，避免重复评论和自回声。
- 原生 MR 归属、目标分支、合并/关闭状态独立核对；Git 推送凭据与 REST API 凭据分别配置。

可先采用出站 REST 轮询，常驻服务不必暴露公网 webhook。领域 core 不需要为 GitLab 重写。当前选择本地渠道即可继续使用，不需要迁移仓库或用 GitHub 中转需求。
