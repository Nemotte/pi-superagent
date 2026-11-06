# Pi Super-agent：已确认需求与实施状态

## 用户决定

独立常驻服务；首发 CLI、Pi 插件和 Web；一个 npm workspace、两个协调发布的包；Linux/macOS/Windows 原生客户端目标；单管理员，一个实例管理一个应用的多个协作 Git 仓库，保留单仓库兼容；各实例配置、数据、端口及服务身份独立。

当前开发优先级（2026-11-06）：**先完善跨机器、跨系统的新安装体验，让其他环境一次安装进入使用向导**，沿用文档化后直接实现。采用统一发布目录和原生 Node 安装器，见 [安装规范](specs/2026-11-06-portable-install-design.md)；真实 systemd 部署验收顺延，全新安装不扩展历史实例的恢复边界。

既有产品决定：**与 GitHub 解耦，先支持本地服务，以及在本机 Pi 中通过 SSH 管理远端服务；其他缺口依次补齐。** GitHub 降为可选来源/渠道，其真实 PR 流程不再是基础 Alpha 发布的前提；飞书继续延期。一个 Super-agent 统一管理应用多个仓库的既有决定保留。延续“设计文档化后直接实现，不另拆计划、不重复审批”，本轮见 [本地与 SSH 规范](specs/2026-11-04-local-ssh-design.md)。早期规范中的 GitHub 优先是历史顺序，以此处最新决定为准。

## 已落地

- npm workspace：`@nemotte/pi-superagent`、`@nemotte/pi-superagent-extension`，版本 `0.1.0-alpha.1`，配置为 public / alpha；尚未发布。
- 上游领域核心及领域测试独立移植；保留 MIT 许可证和来源。
- SQLite 仓储、事务回滚、持久 Effects generation、重试、Outbox 手工渠道收据、审计及版本化配置。
- 实例锁、人工请求幂等、授权检查、暂停、跟进、停止、失败重试及重启恢复接线。
- 独立 Pi Router/Worker 子进程；固定 SDK 1.5.0；显式工具和资源装配；工单 worktree 和持久 Session。
- 稳定投递 ID 包在 user message JSON 中；确认时检查并 fsync Session 文件，而非 SDK 内存队列。
- `job_start` / `job_status` / `job_cancel`；有限输出、进程树取消、持久任务结果。
- 本机管理 API、Bearer 认证、Web cookie/CSRF/Origin/Host/CSP。
- CLI、人工事项优先的 Web 工作台、Pi 命令/工具/状态；前后台启动、认证关闭及离线备份。
- 离线真实 Pi SDK 集成脚本、npm tarball 安装验证脚本、三平台 CI 定义。
- GitHub 原生 REST 客户端、专用 PAT 身份核验、Issue/PR/评论/Review/CI/关闭合并接收、持久游标及限流退避。
- GitHub Outbox 评论与 review 回复、丢失响应后的远端标记核对、PR 所有权绑定和幂等 draft PR 创建。
- 主动推断逐规则/方向/证据评估，observe 的 would_accept、auto 接单、策略变更通知与重新授权检查。
- Web GitHub 来源配置/健康、工单搜索与状态筛选、事件增量读取、决策/输入/线程记录、有限 Session/Job 诊断。
- CLI 与 Pi 插件增加来源、记录和工单诊断入口。

## 本地优先与 SSH 管理（2026-11-04）

- 未启用 GitHub 的单/多仓库都不装配 GitHub PR 工具、专用 read/follow 参数或发布指引；宿主保留实时授权/来源检查。新实例默认交付约定改为工单沟通和验证证据，已有设置不迁移。
- 新服务 `remote-control.ts` / `remote-child.ts`：仅受限 stdio 操作，远端环境/发现/初始化/身份核验、token-only 连接、启动/重启/停止和固定 SDK 登录事件桥。SSH 控制流退出不停止常驻服务；未知身份、锁/端口占用拒绝继续，不强杀服务或删锁。
- 插件 `ssh.ts` / `remote-connections.ts` / `remote.ts`：系统 OpenSSH 参数与环境隔离、严格主机密钥、私密 stdin、超时/取消/输出上限、连接池、生命周期、SSH 向导和远端模型适配。token 仅保留于内存 Client，旧连接关闭后请求/私密展示均拒绝。
- `/superagent ssh` 绑定本机项目入口与远端实例；`connect`/`disconnect` 管理隧道，`start`/`restart`/`shutdown` 显式管理远端服务。`models`、Web 和任务操作复用现有入口。会话启动不建 SSH；模型工具不建连接、不管理生命周期。退出/reload/切换会话清理控制与认证进程，远端继续运行。
- 首版远端 Linux 需预装 Node24、Git、同版服务包和 checkout；不自动安装、克隆或同步代码。为了保留精确 Host/Origin，本机转发使用远端同端口，冲突明确拒绝；任意不同端口映射后续单独设计。远端模型 OAuth 可使用手工回调，真人验收待完成。
- 新 [SSH 指南](../ssh.md) 说明 tarball 部署、命令、信任范围和排障。`test:integration` 增加控制桥/SDK 测试；`test:ssh` 是额外 Linux Docker + 真实 OpenSSH/Chromium 集成。
- 本轮临时 OpenSSH 容器已验证错误 host key 拒绝、真实隧道 API/Web 一次性登录、断线/重连、远端服务持续运行、重启保持暂停/请求及显式关闭。容器/密钥已清理；未连接真实云服务器或个人 SSH 私钥，未调用付费模型、修改业务实例或发布 npm。
- 内联审查补齐本机 SSH 环境白名单、端口冲突预检、在途登录/控制进程的会话清理，以及可修复旧失效本机绑定。旧 NACK 测试将 fork 冷启动纳入 500ms 导致全量并发下超时；保留明确 NACK 错误断言，使用套件正常超时，不修改生产投递机制。

后续顺序：跨系统安装矩阵实际执行、真人 TUI/云端 OAuth/真实任务、真实 systemd manager/开机验收和发布；跨机/路径/schema 迁移及业务数据保留另行实现。GitHub/GitLab 原生渠道扩展不阻塞本地主线。

## 跨系统统一安装（2026-11-06）

新增 `distribution/install.mjs`、`scripts/release-bundle.mjs`、`scripts/install-smoke.mjs` 和 [新机器安装指南](../installation.md)。预编译两个 tarball + 已验证生产锁，不带 node_modules；Node 24+/npm 10+/Git 2.31+ 预检，默认预览、确认后安装到不存在的目录。原生 Node 启动 npm/CLI，无 shell/npm.cmd。服务与插件依赖根分开，匹配 Pi 使用独立 profile，不改个人配置；安装完成前真实 SDK 加载插件，不自动启动业务或模型。

构建一次产物，CI Linux/macOS/Windows × x64/arm64 消费同一 artifact；消费者不安装开发工作区依赖。全部安装与既有测试门禁通过才输出 verified artifact，不自动 npm 发布。当前已有 Linux x64 空 HOME、上层 npm workspace 隔离、中文/空格路径、真实 Pi RPC/SDK 引导/遮罩测试 key、CLI/Web/Node Job 的临时环境验证；其他平台仍需 CI/实机证据。macOS/Windows 系统托管和历史实例跨路径/跨系统迁移另行实现。

## 校验型备份与原路径恢复（2026-11-05～06）

按 [备份规范](specs/2026-11-05-verified-backup-restore-design.md) 增加 CLI `backup`、`backup-check`、`restore`、`backup-prune`。离线锁/端口/托管检查，私有快照和完整清单/摘要，目标副本 SQLite WAL 恢复与 schema 校验，保留身份、凭据、暂停状态和请求；恢复/清理默认预览，需 UUID 与显式确认。恢复限定原主机/账户/个人目录/原路径，不覆盖已有目录、不启动服务、不恢复 systemd 登记。运维步骤见 [备份与升级指南](../backup.md)。

外部 Git 对象及 worktree 管理区不复制、不重置，恢复要求匹配；源 checkout/common-dir 需独立于实例。保留清理至少留一份，仅处理本实例完整快照，未知/损坏/软链接和受保护路径不删除，不自动清理业务数据。宿主 Git 禁止 partial clone lazy fetch；真实 SDK 回归要求恢复后仍选中同一最近会话，文件时间戳由带摘要的清单保存。

本轮完整验证 55 文件/453 测试、SDK/Web/OpenSSH/tarballs/生产审计/20 轮稳定性通过，含 22 项备份回归。内联审查还补齐清理范围、关键链接、清单元数据摘要、原生 SQLite 线程退出及 OS 账户/个人目录检查。全部使用临时数据，无业务实例备份/恢复、宿主系统注册或 npm 发布；core/upstream 未改。

## Linux 系统托管（2026-11-05）

按 [托管规范](specs/2026-11-05-systemd-supervision-design.md) 实现 systemd 245+ 用户服务。CLI `service` 和 Pi `/superagent service` 可管理本地/SSH binding；注册、启用自启和启动分别确认。旧实例仍为 detached，未自动迁移。unit/UID/实例/路径/摘要归属检查，拒绝编辑、symlink、drop-in 和无归属 unit；保留部分声明供人工恢复，不回退启动第二个 detached。

unit 使用 env-i、固定 launcher/CLI、私有环境白名单、35 秒失败重启和 5 分钟 5 次节流；关闭清理本 unit 子进程，暂停和任务状态沿用现有持久机制。CLI start/shutdown 及 Pi/SSH 重启识别托管；取消信号停止后续控制步骤。安装不启动、不 enable；enable 为登录自启，无登录开机运行需要管理员另行配置 linger。见 [部署说明](../systemd.md)。

临时 unit 通过 systemd-analyze；实际 launcher 的服务进程 SIGKILL 后，等待 35 秒、由测试脚本重启，核验请求/配置/暂停保留和正常退出释放锁。**真实 user manager 自动拉起及开机运行待部署验收**；未向宿主注册 unit 或改 linger。本轮完整验证 54 文件/429 测试、SDK/Web/OpenSSH/tarballs/生产审计/20 轮稳定性通过，core/upstream 未改，无真实业务实例操作或 npm 发布。

## SDK 安全升级与稳定性（2026-11-05）

按 [安全升级规范](specs/2026-11-05-sdk-security-stability.md)，服务固定 SDK 1.5.0；插件 SDK/TUI dev 同步 1.5.0，optional peer 下限 ^1.5.0，仍复用宿主 UI，不带另一份生产 SDK。minimatch 11.0.3、undici 8.12.3 已消除原安全公告；项目、插件独立 tarball、服务+插件干净安装的公开生产 audit 均为 0。

- 依赖契约先红后绿；新增真实 SDK JSON Schema validator 兼容测试，覆盖 1.5 的 TypeBox 校验迁移。现有实例认证、代理、持久投递和资源隔离无需修改生产适配代码。
- 调查本轮协调通知偶发失败，独立循环捕获系统 wall clock 回拨约 1.3 秒：已持久 relay 尚未到期，一次 tick 不发送。套件改为受控 Date；补回拨/重开数据库后保留、到期只投递一次、背景不唤醒的确定性回归。生产排期逻辑不变，时钟回拨会延后 due 工作。早期同类单次失败未保留时钟证据。
- 远端初始化测试遇到 listen(0) 释放端口后的竞争；fixture 改用临时连接池外的探测端口，另验证占用端口拒绝且不写实例、不关闭其他 listener。
- 新 test:security 检查项目及真实安装消费者；test:stability 重复 coordination/driver/remote-control，首个失败即退出并保留逐轮日志。三平台 CI 定义新增审计与 10 轮稳定性、日志上传，本机最终 20 轮通过。
- 完整 verify/Web/真实 SSH/生产审计通过，51 文件/406 项；core/upstream 保持原样，未操作业务实例或发布 npm。使用新版需要更新宿主 Pi 1.5+、本地/远端包依赖并显式重启服务。

## 开源原型面板对齐（2026-11-04）

依据 [审查](../research/2026-11-04-upstream-product-ux-audit.md) 和 [对齐规范](specs/2026-11-04-upstream-panel-alignment.md)，本轮实现主流程对齐，未改动 core 或 upstream：

- 新 `panel.ts` 只读展示层：就绪状态、按 core 分类的工单操作/最新报告、分页持久沟通、请求状态与关联工单、Thread 时间线、全局文本/ID/已存链接搜索和有界设置历史。不改变业务决策或数据库 schema。
- Web 按总览/来源/输入/评估/执行/设置组织，工作区为独立扩展视图；普通结果不再藏在原始 JSON 中。详情轮询保留输入焦点、草稿和幂等编号，迟到响应不能覆盖新选工单；丢失跟进响应可手动同 ID 重试。
- Router/Worker、并发、主动模式、规则和团队约定表单；保存前递归三方比较，保留并发无关字段，冲突不写并保留草稿；有显式放弃/重载和分页保存历史。草稿仅保留在当前页面内存，刷新/关闭不持久保存。
- 显式加载型号目录经固定 SDK 子进程执行 metadata-only 操作，隔离环境、超时/关闭取消、单飞缓存和字段白名单；不在管理进程导入 SDK，不做模型认证或付费 probe。
- `/superagent models` 从当前或继承的成员绑定直接配置某角色/共同型号，不重选仓库。命令状态/回执显示摘要，交互式工单列表可直接选择；模型工具无此配置权限，生命周期与配置互斥保留。
- 内联自查补回归：跨项目取消不能显示接收成功、缺回执不能宣称接收；成员目录模型配置复用已有绑定；过滤输入不链接不存在的 Thread；已翻页后从回执入口回到最新输入；旧服务不认识新静态模块时显示重启指引。
- GitLab 本地 checkout 可走 Pi/Web 需求渠道，无需 GitHub；GitLab Issue/MR 原生来源仍未实现。新增 [GitLab 说明](../gitlab.md)，补充 GitHub @ 机器账号、允许名单、轮询、Router/Worker 和 Outbox 回复的具体流程。
- 验证：全量 `verify` / `test:web` 通过，新增面板 Chromium 场景与 API/插件测试先红后绿；安装包测试读取真实固定 SDK 型号元数据。桌面及 390px 移动视口检查无横向溢出。内联自查，无独立 reviewer。
- 本轮只用临时仓库和实例。未重启/转换真实业务服务，未配置真实模型、付费调用、恢复派单或改动业务仓库。新增 API/静态路由需要用户在 Pi `/reload` 后明确 `/superagent restart`，再刷新 Web。

后续对齐项：完整提示词模板/技能覆盖编辑、默认版本升级合并；更完整的来源准入表单及其草稿/冲突交互；24 小时活动统计和更细的执行/会话筛选；DSH preset/嵌套子 Agent 等宿主特性的 Pi 适配。当前主流程对齐不等于所有公开原型功能均已移植。

## 本轮协作语义修正

上一轮对照发现：虽然领域内核与上游相同，Router 通知、指令传递、上下文工具、外围策略和面板仍有缺口。本轮按 [语义校准规范](specs/2026-11-02-superagent-alignment.md) 修正适配层：

- `notices.ts` / `runtime.ts`：持久化人工跟进、Worker 问题和结果通知；Router 可处理讨论中的停止请求。普通进度不唤醒 Router；结束/设置背景通知使用不触发轮次的 Pi custom message，仍核对磁盘持久确认。
- `prompts.ts` / `pi-child.ts`：Router 受控 reply/note/status，Worker ack/context follow/unrelated；移除固定接单确认和 ready/dropped 自动外发，人工问题原样转达。
- `context.ts`：候选、工单、输入、报告和工具变更结果使用有界卡片及展开指针；支持分页 Thread/原始 GitHub 讨论、仓库内只读文件和归属校验。
- 团队 communication/scope/delivery、匹配规则全文、项目根 AGENTS.md 进入 Worker 指令；活跃工单收到更新，配置保存历史快照。指令预算与读取限制见校准规范。
- `policy.ts`：恢复保守准入默认和每类事件的准入表，区分监听与接收全量消息、context-only 与有效跟进、规则变化与授权撤销。关闭全量观察不撤销仍监听 Thread 的既有授权。
- `attention.ts` / Web：默认显示待人工事项，直接回答、重试、重新评估或忽略提示；连续三次故障才升级，健康指标与原始 JSON 收入次级详情。修正管理 API 退订时混用 Ticket ID 和 Thread key 的问题。

## 插件初始化引导（2026-11-04）

按 [引导规范](specs/2026-11-04-plugin-onboarding.md) 实现 `/superagent` 入口和 `/superagent setup`：选择仓库/实例、空闲端口、单 Worker/暂停/GitHub 关闭的初始化、后台启动确认、模型选择、实例专属 OAuth/API key 登录、可选模型探测和恢复派单。

- 项目绑定保存在用户私有 connections 目录，校验实例身份，优先于旧环境连接；不写目标仓库。新实例数据目录拒绝放在 Git 工作树中。
- 会话启动不创建实例或启动服务；取消后保留已创建的实例，后续可以继续。连接既有实例不改配置。跨项目/SSH 环境连接的写操作需用户命令确认，仅对当前会话、项目、端点、实例身份有效。
- 服务公开轻量 bootstrap 入口，插件通过 CLI/API 和独立认证 IPC 调用固定 SDK，不在前台嵌入 SDK。认证子进程不继承个人认证文件或模型密钥环境；秘密输入遮罩，不写聊天或 argv。
- SDK 登录后的认证就绪与真实模型请求探测分别报告；探测只在用户确认后执行一次，失败不自动恢复派单。过期/不可解析认证可重新进入登录。
- 目前向导初始选择同一型号供 Router/Worker 使用，后续可分别调整。已有 Agent 切换型号仍需重启服务；向导不自动中断任务。
- 本次只操作临时测试仓库和实例，没有安装用户全局插件、创建真实新项目实例或改动既有业务实例。没有执行新的真人 OAuth 登录或付费模型任务。

## 多仓库应用工作区（2026-11-04）

按 [多仓库规范](specs/2026-11-04-multi-repository-workspace.md) 实现，一个实例和工单统一协调多仓库；领域 core 保持原样。

- 可选 `workspace.repositories`、最多 32 个相对路径成员，支持根仓库 `.`；根和成员固定为实例身份。旧实例不自动迁移。
- 只读有界发现、HEAD/dirty/gitlink 信息与缺失模块诊断；CLI `discover` / `init --workspace --member`、插件工作区选择与成员勾选。
- 派工前持久保存各仓库 HEAD/common-dir 与父 gitlink 基线，再按原目录布局装配 worktree；失败重试、服务恢复复用版本和任务改动，原目录未提交文件不复制。
- 拒绝重复 common-dir、已追踪目录重叠、错误仓库/工单目录和 symlink 重定向。实例数据目录必须位于工作区外；Git 检查/装配去除继承的仓库覆盖变量。
- 工作区根 AGENTS.md、各成员 AGENTS.md/CLAUDE.md 按路径传给 Worker，总预算 32000 字符；Router 文件读取排除未注册嵌套仓库。
- ready 报告需按仓库给出摘要/检查，并覆盖实际变更仓库。已有子 HEAD/gitlink 差异单独显示，不冒充本次变更。一个 Worker 在同一工单内跨仓库操作，无自动混合提交/推送。
- API、CLI、Pi `workspace [ID]` 及 Web 展示成员、基线、变化与验证；从成员子目录进入 Pi 可继承工作区绑定，未注册相邻/嵌套仓库不继承。
- 当前多仓库只接本地派单；单仓库 GitHub 流程保留，多仓库 GitHub/PR、GitLab 与原地执行继续留待接入。
- 新发现器曾只读核验一个多仓库应用，与此前调查一致。没有创建业务实例、worktree 或分支，没有同步模块、运行其服务或改动文件。真实 SDK 验证全部使用临时仓库与本地脚本模型。

## 初始化登录交互与 Web 入口修正（2026-11-04）

按 [登录恢复规范](specs/2026-11-04-onboarding-login-recovery.md) 修正：

- 用户已通过向导创建本地实例。本轮不停止/重启用户服务，不代发 OAuth、付费模型请求或业务任务，不读取用户令牌内容。
- OAuth 链接由插件通过原生参数数组尝试打开，每个 URL 一次；失败仍保留手动链接、设备码和进度。登录结束清除临时登录栏，连接栏继续显示 Web 地址。
- 手动回调采用真实遮罩 Input，空 Enter 不提交，Esc 先确认取消；SDK 关闭过期输入框的 resolve/reject 均继续等待认证结果，UI 异常独立脱敏。补齐 focused 委托和 OpenAI 订阅认证所需的实例稳定 getDeviceId。
- 此阶段的 `/superagent web` 和菜单“Web 地址”只展示地址；随后已升级一键登录，单纯查看改用 `/superagent web url`。status 返回实际客户端 webUrl。向导认证前、取消后、session_start/重载及离线状态均保留连接地址，不借此启动服务。
- 新增回归先红后绿；干净安装验证固定地址和临时登录栏清理。真人浏览器 OAuth / 完整 Pi TUI 留待用户重试，本轮验证未使用其账号。

## 一键 Web 登录与令牌入口（2026-11-04）

按 [Web 登录体验规范](specs/2026-11-04-web-login-experience.md) 完成：

- `/superagent web` 显式申请 60 秒单次授权并打开浏览器；默认不用寻找文件或输入长期 Token。自动打开失败时，临时私密面板提供链接及复制。`web url` 只显示普通地址，离线可用。
- `/superagent token` 确认后打开遮罩面板，V 显示/隐藏、C 复制、Esc 关闭、60 秒自动关闭；凭据不返回模型或聊天。原生剪贴板命令通过 stdin 接收值，不使用 shell/秘密 argv。
- 授权只能由 Bearer 客户端申请，内存中仅留 hash/origin/到期时间，最多 32 条，重启失效。Web 清理 fragment 后同源兑换 cookie，保留 CSRF/Origin/Host/限流保护，cookie 名按实例隔离。
- 加载/会话启动/模型 `web` action 不生成授权或打开浏览器；未绑定跨项目管理仍需用户确认。已有服务需要重启加载新接口，现可用 `/superagent restart` 在插件内确认操作；令牌面板可配合旧服务使用。
- HTTP、插件和真实 Chromium 覆盖一次性、并发重放、超时、跨实例/origin、刷新、退出、遮罩及旧服务提示；干净安装实际兑换 cookie。本轮未读取用户令牌内容或改动其服务、仓库和凭据。

## 插件内重启（2026-11-04）

按 [插件重启规范](specs/2026-11-04-plugin-restart.md) 增加 `/superagent restart` 和菜单“重启后台服务”，旧版 Web 的提示同步指向此入口。

- 仅管理已确认绑定的本地实例，核对磁盘/服务身份和端点；环境或 SSH 隧道连接不被当作本地进程。模型工具和 session_start 不能触发重启。
- 显示目标、暂停状态、忙碌 Worker 数与中断影响，确认后先执行 CLI 预检，再认证 shutdown。等待实例锁消失且端口关闭后启动，用新客户端核对身份。保留配置、凭据与工单，不自动改变暂停状态。
- 等待有界；超时、停止失败、身份变化不启动第二个服务，不强杀或删除锁。已停止且锁/端口空闲的本地实例可确认启动。同一插件防重复重启和向导交叉执行。
- 新增 13 项测试；真实服务/锁/端口测试覆盖状态保留及失败路径，干净安装覆盖实际插件重启与 Web 登录。用户实例未被本轮测试操作。

## 本地优先管理模式（2026-11-04）

按用户要求先跑通本机，保留共享部署的认证入口；见 [本地模式规范](specs/2026-11-04-local-management-mode.md)。上述 Web 一键授权和令牌面板现在适用于可选 token 模式。

- 新实例默认 local，无 admin.token 也能启动、查询、派单、重启和打开 Web；浏览器直接进入，无登录/退出控件或 cookie。Host/Origin/CSP 保留，本地写请求需要 JSON 与自定义客户端头。
- `management.json` 独立于 SQLite 配置；缺少文件的旧实例保持 token 模式。离线 CLI `management local|token` 加锁、核对可选 expected instanceId 后原子写入；切回 token 可生成缺失凭据，切到 local 保留但不读取旧 Token。
- `/superagent local` 显式确认、CLI 功能预检、旧连接退出、锁/端口双等待、离线转换、启动后身份核对；不要求 Web 或模型登录。`restart` 保留当前模式，模型工具不允许切换。
- 插件与 CLI 改用独立 Node HTTP、禁用共享连接池、10 秒截止与 8 MiB 响应上限；宿主 fetch/代理不处理本机管理流量。失败显示有界 HTTP 状态/错误码，避免再次只剩通用后验错误。
- 只读调查一个既有实例：绑定与磁盘身份一致，`/health` 为 200，日志包含新进程监听记录。旧错误的具体根因因原先吞错而未确定。本轮未读取用户 Token、修改模式或重启业务实例。
- 测试先红后绿；Chromium 验证本地直接进入/写入/刷新，安装包验证旧实例 token → local、删除测试 Token 后再次重启、配置与工单保留，并令宿主 fetch 故障验证生命周期独立。CLI 另在失效代理、NODE_USE_ENV_PROXY=1、空 NO_PROXY 下验证。补齐静态页外链导航和旧登录链接在本地模式下恢复进入的回归。全部使用临时实例。此处为内联自查，无独立 reviewer 工具。

## Web 提交回执（2026-11-04）

按 [提交反馈修复](specs/2026-11-04-web-submission-feedback.md) 处理“提交给 Router 没反应”：实例已持久接收输入，但实例暂停且 Router/Worker 模型未配置，工单列表为空。

- 提交区显示暂停/模型配置提示；POST 成功立即显示请求 ID，提供已提交请求入口，不再只清空输入框。
- 提交中禁用控件并防重入，10 秒截止；响应丢失时保留文本/幂等键供手动重试。后续读取失败不覆盖成功回执。页面刷新后仍可通过记录查看持久输入。
- 新增独立 Chromium 提交回归并纳入 test:web，先复现已存储但无回执的失败，再修复。完整 verify 与三组 Web 脚本通过。
- 只读 Chromium 检查既有实例页面：新提示和原请求均可见，零写请求。没有代替用户选择模型、登录、probe、恢复派单或重启；用户可刷新 Web 并通过 `/superagent setup` 第一项继续配置现有实例。

## 验证证据

本地环境：Linux x64，Node 24.14.1。2026-11-06 最新 verify/Web/OpenSSH/security/stability 20 轮及 release:bundle、实际 test:install --audit 全部通过：57 个测试文件、464 项测试；TypeScript、两包构建、SDK 1.5.0 直连/代理/多仓库、控制桥/测试认证、systemd unit/launcher 崩溃恢复、CLI 备份恢复、tarball、Chromium、真实 OpenSSH 通过。项目、两类 tarball 消费者及统一安装 runtime/client 五项生产 audit 均为 0。七套件 20 轮无失败/无重试；脚本语法、六目标 CI YAML、core 一致及 upstream 无改动检查通过，无测试 SSH 容器残留。

全量日志 `/tmp/pi-superagent-portable-verified.log`，逐轮 `.artifacts/stability-1793934466255-1371934/`。本地发布目录 `.artifacts/portable-release/`；ZIP `.artifacts/pi-superagent-0.1.0-alpha.1-portable.zip` 已解压再安装验收。首次全量遇到 systemd 脚本固定等待后的锁占用，原失败保留 `/tmp/pi-superagent-portable-final.log`；独立采样发现约 2.5s 墙钟回拨，测试现按锁龄/单调截止等待，生产锁及 unit 参数不变。其他 OS/架构仍需实际 CI/部署证据；未修改业务实例、个人 Pi 配置或宿主系统服务，未发布 npm。

- 统一安装 9 项单元回归，覆盖平台/Node/npm/完整性/确认/路径/环境/失败及实际入口；真实空 HOME、中文/空格路径、父 npm workspace、SDK 加载和遮罩引导、CLI/Web/幂等请求/Node Job、停止；ZIP 往返后二次安装通过。
- 领域及适配器测试、TypeScript、构建。
- 备份回归涵盖 WAL 崩溃副本恢复、源字节保持、格式/路径/类型/摘要损坏、关键链接、身份/账户、端口/托管拒绝、初始化锁竞争、保留清理范围、单库/嵌套多库暂存与未暂存文件、SDK 最近会话及数据库线程退出；真实 partial clone 验证宿主禁止 lazy fetch。
- 真实临时 Git worktree，含空格和 Unicode 路径、嵌套 gitlink、缺失模块、父子 HEAD 差异、源 HEAD 前进后的恢复、分仓库 ready 报告和实例私密目录校验；补充仅选择嵌套子仓库时的读取权限与向导手工输入路径兼容回归。
- `scripts/workspace-smoke.mjs` 用一个真实 SDK Worker 修改前端和嵌套考试服务，以真实 Node Job 对比两端接口文件，报告完整结果；核验父仓库的原有 gitlink 差异不计为任务改动、原 checkout 不变、重启后报告保留。11 次本地脚本模型请求，无付费模型调用。
- 真实 Node 子进程 IPC、启动退出、负确认、角色绑定及停止。
- 真实 Pi SDK 会话使用本地脚本化模型，完成 Router → Worker → Router 受控回复；另验证 Worker 提问 → 人工跟进停止、静默规则正文与项目 AGENTS.md 传递、背景通知持久化且不调用模型。重开 SQLite 保留状态，无付费模型调用。
- 打包脚本在独立目录安装两个 tarball，检查 CLI、静态资源、后台进程生命周期及备份；新增实际安装包多仓库发现/向导 → CLI 初始化 → 后台服务 → 固定 SDK API-key 登录 IPC → 配置保存 → 成员目录重连/本地派单闭环。测试输入为假 API key，跳过付费模型探测；真实 Input 组件的私密字符不出现在渲染文本。此项使用脚本驱动 UI，不替代完整 Pi TUI/浏览器 OAuth 人工验收。
- 真实 Pi SDK 加本地 GitHub REST 模拟端点完成外部请求 → 接单 → Worker → GitHub 回复 → 重启去重闭环，没有真实 GitHub 写入。
- 本机 Chrome/Chromium 验证登录、CSRF、GitHub 配置和健康、默认待人工事项、直接回答、团队约定保存、派单/筛选/停止、运行诊断和安全文本渲染；另展示 SDK 跨仓库任务的三个成员、gitlink 基线、改动、检查证据，以及多仓库来源表单的禁用说明。
- 自查并用回归测试修复 inferred attach 绕过 observe、CI 重启标识复用和空检查误报恢复等边界；本轮新增通知事务/恢复、回复保序、提问原样转达、长文本工具结果、角色与路径边界、上下文读取限流及策略矩阵回归。当前工具无独立 reviewer 子代理，审核为本会话自查。
- `diff -qr upstream/src/core packages/server/src/core` 无差异；`upstream/` 工作树和暂存区保持不变。

首轮代理冒烟的 quiet fixture 出现一次超时；加入失败时的 Trigger/Decision/脚本调用诊断后未复现，单独及最后全量重跑通过，未修改调度逻辑。

## 真实 GitHub 接入进度（2026-11-03）

- 在专用机器账号与私有测试仓库中核验 PAT/仓库身份、Issue/PR 读取、真实轮询和受控评论写入；凭据保存在执行主机实例中，不进入 Git URL 或配置。
- 实例专属 OAuth 与真实只读模型任务通过。联调发现 SDK 覆盖 Node 代理 dispatcher，已修正并补直连/代理回归，见 [代理修正](specs/2026-11-03-agent-proxy-fix.md)。模型选择以认证接口实际支持的目录为准。
- 首次 Worker 使用个人 gh 凭据错误发评论，完整协作验收失败。已隔离 HOME/环境/配置、拒绝直接 gh 调用并修正回复路径，见 [凭据修正](specs/2026-11-03-worker-credentials-fix.md)；错误评论未自动删除。
- 经授权重测，Worker 只读执行并报告，Router 经 Outbox 发布结果；核验评论作者为机器账号、投递标记匹配，重启和再次轮询后无重复回复或执行。
- 未修改测试仓库源码、推送分支或创建 PR。真实 GitHub 跟进/stop、代码推送和 PR 生命周期仍需进一步验收。公开文档不包含测试账号、实例路径、任务 ID 或私有仓库链接。

## 尚未完成／发布阻塞

- GitHub/GitLab/飞书均为可选渠道，不作为本地/SSH 基础 Alpha 的发布前置。飞书按用户要求延期。GitHub 当前支持 github.com 机器账户 PAT；真实账号/私有仓库读取、机器账号接单和结果评论、管理 API 跟进重开工单、重启去重已验证；个人 gh 登录误用的修正已经真实重测。GitHub 渠道的新人工跟进及 stop、代码推送和 PR 生命周期继续联调，App/Enterprise 尚未接入。
- 多仓库实例可由用户通过向导创建，真人 OAuth 交互及跨仓库真实模型任务尚未完成验收；多仓库 GitHub/PR、GitLab、原地执行模式尚未接入。
- 真实模型对书面规则、沟通时机与复杂跨工单协作的行为验收；离线脚本模型已验证传输与工具链，下一步用实际模型和测试仓库验收协作质量。
- systemd 用户托管已实现；实际 user manager 自动重启、linger 开机运行和服务器重启尚待验收。launchd、Windows 原生托管及真实三平台生命周期尚未完成。
- 上述剩余开源原型功能对齐、交互式 Pi TUI 操作验收及更完整的运维检索；本轮新增 Web 关联导航、对话/设置历史与跨记录检索。
- 跨机/改路径及 schema 迁移、业务数据保留和完整故障注入矩阵；校验型离线备份、原路径恢复与显式备份保留已实现。
- SDK 依赖安全阻塞已由 1.5.0 升级和消费者审计解除，见根 `SECURITY.md`；后续版本持续运行安全门禁。真实系统托管验收、跨机/路径迁移、真人及多平台验收仍待完成。
- npm scope 所有权和正式发布流程。

## 研究与仓库边界

上游固定提交：`6337fc823ce20251c8de8085948165c81aaa701e`。参考目录 `upstream/` 保持不变，不作为安装运行依赖，也不进入 npm tarball。调研报告见 `../research/deepseek-superagent-architecture.md`。

产品现已独立初始化 Git，并配置用户指定的远端 `https://github.com/Nemotte/pi-superagent.git`。源码与 CI 由产品仓库管理，未借上游 Git 历史承载产品提交。首次推送排除运行数据、凭据、依赖、构建产物和本地研究 checkout；历史文档中的私有联调标识已去标识化，原记录只保留在本地忽略目录。npm scope 尚待确认，未发布 npm 包或注册宿主系统服务。
