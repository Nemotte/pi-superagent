# 本地优先与本机 Pi 管理 SSH 服务

## 决定与交付顺序

用户确认：插件先与 GitHub 解耦；在本机 Pi 内启动/管理本地服务，或通过 SSH 管理云服务器上的服务。GitHub 降为可选来源/渠道，不再作为基础安装、派单或 Alpha 发布验收的前提。延续“设计文档化后直接实现，不另拆计划、不重复审批”。

本轮交付 GitHub 能力按配置装配，以及第一版 SSH 管理。后续依次完成 SDK 安全依赖升级/稳定性、系统托管与备份恢复/保留策略、真人和多平台验收/发布。保持 upstream 和领域 core 不变，不操作真实业务实例。

## 架构选择

采用系统 OpenSSH + 远端服务包内的受限 stdio 控制桥 + loopback 本地转发。沿用现有 HTTP API/Web 和实例授权，不新建公网 API。

对比方案：
- 仅提供手工 ssh 命令：代码少，但插件不能可靠核对远端身份或管理生命周期。
- **OpenSSH 控制桥及隧道（采用）**：复用用户已确认的 SSH 主机、密钥及 ProxyJump；秘密经加密流传递；服务与连接解耦。
- 公网 HTTPS/云管理平台：需要额外证书、暴露面和部署系统，超出单管理员目标。

```text
本机 Pi 命令/UI → OpenSSH → 远端 stdio 控制桥（检查/初始化/生命周期/认证）
本机 Pi/Web → 127.0.0.1 本地转发 → SSH → 远端 127.0.0.1 API
远端常驻服务 → SQLite/Router/Worker/远端任务 worktree
```

## 首版范围

- 本机安装插件及系统 ssh；远端 Linux 已安装 Node 24+、Git、同版服务包，已有带 HEAD 的 checkout。向导输入 SSH 别名或 user@host、Node 命令/绝对路径、服务 dist/cli.js 绝对路径和实例目录。
- 服务包未安装或运行时不可用时给出明确预检错误；不执行 sudo、不安装运行时、不自动克隆仓库或上传本机代码。服务包可从可信构建目录或 tarball 手动部署，与 GitHub 无关。
- `/superagent ssh` 和 setup 的 SSH 选项：连接已有实例，或在远端已有仓库/工作区创建新实例。多仓库发现和成员选择在远端进行，确认后固定集合。
- 新远端实例强制 token 管理、GitHub 关闭、一个 Worker、暂停派单。已有实例保留配置；首版要求 token 模式，local 实例由用户在远端显式转换，不自动降级认证。
- 创建、启动、停止/重启、模型 probe、恢复派单分别由交互式用户确认。模型工具不能调用这些入口。
- `/superagent connect` 连接已绑定远端；`disconnect` 只关闭隧道；`start`、`restart`、`shutdown` 管理绑定远端服务。普通用户命令可建立已授权绑定的连接，不自动启动服务；模型工具只能复用已建立连接。
- 模型选择/认证复用现有私密 UI，SDK 在远端实例目录运行。OAuth 浏览器在本机打开，远端 localhost 回调需要复制完整回调地址到遮罩框；设备码流程按提供商提示进行。认证就绪、推理验证和恢复派单分别处理。
- 关闭 Pi、reload、切换会话释放插件持有的 SSH 进程及内存凭据，不停止远端服务。连接断开显示离线；不自动重启服务或重发写请求。

首版使用与远端服务相同的本机转发端口，保留现有精确 Host/Origin 校验。创建时优先选择本机空闲端口并在远端预检；已有实例若本机同端口被占用则明确拒绝，不占用/停止其他服务、不悄悄换 Origin。任意不同端口映射留待独立授权来源设计。

## 模块与身份

- 服务 `remote-control.ts`：有界请求 schema、远端路径/身份检查、只读发现/检查、初始化和安全生命周期。
- 服务 `remote-child.ts`：SSH stdio JSONL 协议；固定 SDK fork 的登录事件转发；关闭连接只清理认证子进程。
- 插件 `ssh.ts`：主机/路径校验、POSIX 安全参数引用、OpenSSH argv、受限 JSONL RPC 与隧道资源。
- 插件 `remote.ts`：连接池、远端身份核验、向导、生命周期、认证服务适配。
- 现有 `instances.ts` 扩展可区分的 SSH 绑定，记录本机 project、远端 repository/stateDir/instanceId/port/host/node/cliPath，不含 token。远端路径不用本机 realpath；不自动推断本机目录与远端成员的映射。
- 现有 setup 模型流程使用连接 endpoint 和服务适配器，不再假设每个实例目录都存在于本机。

SSH 认证信任来自用户已有 OpenSSH 配置和 known_hosts。StrictHostKeyChecking=yes、BatchMode=yes；首次主机确认或密码/密钥解锁由用户先在私密终端完成。不禁用 host key 检查，不复制私钥，不启用 agent forwarding。插件的管理 SSH 可使用本机 SSH agent，但它和 socket 不进入 Worker/Jobs 环境。

请求数据走 stdin JSON，不拼入远端 shell；仅 Node/固定控制桥路径采用正确 POSIX 单引号引用。拒绝主机选项注入、控制字符和非绝对服务路径。ssh stderr 不反射可能带秘密的远端输出；只显示有界安全错误类别。所有 RPC 有截止和输出上限，登录取消/超时清理 prompts 与 SSH 进程。

管理 token 仅在显式连接时经 SSH 读取到本机内存，不写 binding/日志/聊天/模型工具结果/argv。token Web 使用已有一次性授权。每次建立隧道后核对 protocol/instanceId；断开后旧 Client 在任何请求前拒绝，不向被其他进程重新占用的端口发送凭据。

远端 lifecycle 核对 expected instanceId/repository/port，预检 CLI 后请求 shutdown，等待锁和端口同时释放，再 start 和核验；失败不强杀服务、不删锁、不启动第二实例。启动结果未确认时下次先检查实际状态，不假定失败等于未启动。

## GitHub 解耦

- AgentTarget 显式携带当前配置的 GitHub 能力；默认关闭。
- 单/多仓库在未启用 GitHub 时均不注册 GitHub PR 工具，不提供 PR 发布引导或 GitHub 专用读取/follow 选项。
- 宿主再次检查当前配置及角色/Assignment，旧 Agent 在来源关闭后不能继续操作 GitHub。
- 本地任务通过持久沟通渠道交付结果，新实例的团队默认交付约定不以 PR 为前提；已有配置不迁移。
- GitHub 已启用实例保留原功能及回归，不删除已有来源、凭据或记录。

## 验收与边界

- TDD：先失败覆盖未启用能力的 prompt/tool/宿主拒绝，再实现；SSH 覆盖输入引用、主机注入、输出上限、超时、取消、身份变化、暂停保留、断线清理、秘密不落盘和非交互拒绝。
- 临时仓库和服务验证远端控制桥 init/start/connect/restart/shutdown、模型目录/测试认证、本地 HTTP/Web、幂等提交和停止连接后服务继续运行。
- 优先使用临时本机 sshd 验证真正 OpenSSH；若环境没有 sshd，明确记录控制桥/转发 fixture 与真实 SSH 的证据差异，不声称云服务器实测。
- 完整 verify、Web、包安装；core/upstream 无改动。
- 不执行真实云登录、付费模型调用、真实系统服务注册或 npm 发布。远端 Linux 为首版执行宿主；macOS/Windows 客户端仍需实机验收。

## 检查项

- [x] 梳理现有本地 binding/lifecycle、精确 Host/Origin 和 SDK 认证边界。
- [x] 用户确认本机 Pi 通过 SSH 管理远端；比较方案，选择隧道与受限控制桥。
- [x] 设计自查：区分目标/现状、云端已有 checkout/服务包、token 范围、端口冲突、会话关闭和后台服务的独立生命周期。无需视觉设计辅助。
- [x] GitHub 按能力装配和本地闭环回归。真实 SDK 本地阶段核验零 GitHub 请求/无 PR 工具，启用后的新 Worker 保留原工具；已运行 Agent 的能力更新需显式重启，Web 给出提示。
- [x] 远端控制桥和生命周期测试。
- [x] SSH 连接、绑定、向导与模型入口。
- [x] 断线/秘密/身份/取消回归及安装集成。
- [x] 全量验证、文档和剩余缺口更新。

验证记录：`npm run verify && npm run test:web && npm run test:ssh` 全部通过；49 个 Vitest 文件、399 项测试。SDK 直连/代理/多仓库、控制桥和测试认证、干净安装 tarball（包含实际控制桥调用）、Chromium、临时 Ubuntu Docker 的真实 OpenSSH 全部通过；另检查所有 Web/冒烟脚本语法、core 内容一致以及 upstream 工作树/暂存区无改动。真实 SSH 覆盖独立临时密钥和 known_hosts、错误 host key 拒绝、token-only API/Web、远端 SDK 目录/测试 API key、断线后旧 Client 拒绝、服务存活/重连和重启持久性。未使用付费模型或真实云服务器。

内联审查（无独立 reviewer 工具）：核对参数/路径注入、凭据只走 stdin/连接内存、默认环境白名单、会话关闭清理、身份变化/端口冲突不继续、已有配置不降级。补齐相关失败回归后通过。全量测试首次发现旧 NACK 测试给 Node 冷启动一并限定 500ms；该测试现在保留 NACK 错误断言，使用套件正常截止，不修改生产 ACK 机制。

实施本规范时产品根尚无 Git 仓库，当时在现有工程内编辑，未借 upstream 建分支或提交。
