# 真实联调暴露的 Worker 凭据与回复路径问题

## 事件

Issue #1 的 Router 已通过受控 Outbox 用机器账号确认接单。Worker 读取 README 后调用 job_start 执行 gh issue comment，命令继承了用户主目录中的 gh 登录配置，导致结果以个人账号而非机器账号发布。后台任务继承完整环境、默认 HOME 和登录 shell，加上 Worker 提示没有明确禁止绕过回复通道，共同造成该问题。测试服务已暂停并关闭；原评论保留，未删除。

## 修正范围

- Pi 子进程将 HOME/USERPROFILE、XDG、Windows 应用配置目录及 GH_CONFIG_DIR 指向实例 agent/home，不读取默认个人配置；不传入 GitHub、管理员令牌、SSH agent、Git credential/配置覆盖或 Node 预加载变量。SDK 仍可使用启动服务时明确提供的模型提供商变量。
- 后台命令只继承基础运行环境、区域设置和代理/CA 配置，不继承模型、GitHub、云服务或管理员凭据。默认 home 与 Git 全局配置为实例目录，关闭系统 Git 配置、交互凭据提示和个人 SSH 身份自动选择。
- job_start 拒绝直接执行 gh；GitHub 读取、确认、PR 操作已有宿主工具。Worker 必须把结果交给 superagent_report，由 Router 的 superagent_reply 经持久 Outbox 发布。不得通过 shell、HTTP 或其他 CLI 绕过。
- 提示改用非登录 shell，避免加载用户 profile；增加命令级回归、真实子进程环境回归和回复路径提示测试。

HOME 与环境隔离防止默认凭据发现。进程仍使用运行账户的文件权限；需要抵御任意命令访问其他凭据时，必须使用专用 OS 账户或系统级隔离环境。不会把 worktree 或环境变量隔离宣称为系统沙箱。

## 验证与外部操作

先做离线回归及本机只读凭据检查。不自动删除错误评论，不以个人 gh 登录修正远端。首次工单在业务层已 completed，但该次完整协作验收失败。

用户随后要求重测。通过管理 API 跟进原工单，重新读取 README，Worker 只读执行后提交报告，Router 经受控 Outbox 发布结果。2026-11-03 已核验结果评论作者为专用机器账号、正文三句话、投递标记与 sent 收据匹配；本轮没有 gh 调用。重启并轮询后无重复评论、工单或 Assignment。仓库与 worktree 干净、远端只有原 main、没有 PR。服务恢复在线和单 Worker 派单；上一轮错误评论仍保留。
