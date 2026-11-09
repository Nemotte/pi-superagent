# Pi Super-agent

基于 Pi SDK 的单管理员常驻 Agent 服务，一个实例可管理一个应用的多个协作 Git 仓库。支持本机运行，或在本机 Pi 中通过 SSH 管理远端 Linux 服务；GitHub 是可选渠道，不是安装、派单或基础发布验收的前提。实现从 DeepSeek [Super-agent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype)移植的领域核心，提供 CLI、Web 面板和 Pi 插件。

**当前版本：`0.1.0-alpha.1`，本地开发版本，尚未发布 npm。**

## 当前能力

- 持久化 Ticket / Mandate / Assignment / Subscription，SQLite WAL、事务、Effects 重试和审计事件。
- 管理员派单 → 独立 Router → 独立 Worker → 结构化报告；一个工单可跨前端、后端及嵌套服务仓库执行，保留独立 Git worktree、共同 Pi Session 和分仓库结果。
- 工作区有界发现、成员选择、持久 HEAD 基线、嵌套 gitlink 装配与重启恢复；原目录未提交修改不带入任务，缺失模块不自动下载。
- 输入使用稳定 ID；确认时读取并同步 Session 文件，重启后核对，未确认输入保留在 Effects 中。
- Worker 提供 `job_start` / `job_status` / `job_cancel`，有限输出和进程树取消。
- 通过同一个 `/api/v1` 使用 CLI、Web 和 Pi 插件；支持跟进、停止、失败重试、全局暂停。
- 默认本地免登录模式，不需要管理 Token；可选 token 模式保留 Bearer、Web HttpOnly cookie 和 CSRF。两种模式均保留 Origin / Host 检查及 CSP。
- 前台运行、独立后台进程启动/停止、校验型离线备份/原路径恢复/显式保留清理、实例锁；Linux 可显式选择 systemd 用户托管、登录自启和失败重启，支持本地/SSH 管理。
- SSH 远端检查/初始化/启动/重启/停止、私有绑定、远端 SDK 模型配置、token Web 隧道；客户端断开后远端继续运行。未启用 GitHub 时不装配其工具、读取选项和发布指令。
- 单仓库实例支持 GitHub Issue、PR、评论、Review、CI 及合并/关闭事件；持久游标、限流退避、回复幂等、工单 PR 绑定与 draft PR 创建。
- 主动推断逐规则评估：`observe` 记录 `would_accept`，`auto` 才执行通过方向与证据验证的候选；策略变化通知受影响工单。
- Router 持续收到人工跟进、Worker 问题与结果；跟进中的停止请求由 Router 决策。进度保留内部，背景通知不触发模型轮次。
- Worker 获得团队书面约定、匹配规则正文及项目 `AGENTS.md`；上下文先发摘要，再按指针分页读取。模型决定具体确认和结果回复，静默规则可省略外发。
- Web 按总览、来源、输入、评估、执行、设置组织；统一就绪提示、持久本地沟通、工单详情实时更新、关联导航、全局检索、设置表单/冲突保留和保存历史。原始 JSON 收入高级诊断。
- Pi 提供简明状态、工单选择及 `/superagent models`：已绑定实例直接调整 Router/Worker 或共同型号，无需重选工作区。

飞书已按用户要求延期。Linux 托管使用 `/superagent service` 或 CLI `service`，需先停机，注册/启用自启/启动分别确认，见 [systemd 指南](docs/systemd.md)。已有 detached 实例不自动迁移；无登录开机运行需要管理员另行配置 linger。备份、同机原路径恢复、升级/回退和清理步骤见 [备份指南](docs/backup.md)。尚待完成：真实 systemd manager/开机验收、launchd / Windows 托管、跨机/改路径及 schema 迁移、业务数据保留策略、交互式 Pi TUI 验收。

平台证据：已在 Linux、Node `24.14.1` 上执行测试。CI 配置包含常规三平台测试，以及同一发布包在 Linux/macOS/Windows × x64/arm64 的六目标安装门禁；macOS / Windows 尚未取得 CI/实机运行结果。服务已固定 Pi SDK `1.5.0`；项目及干净 tarball 安装的生产依赖审计均为 0 项，原 SDK 安全依赖阻塞已解除，见 [SECURITY.md](SECURITY.md)。

## 新机器一次安装（推荐）

需要 Node 24+（含 npm 10+）、Git 2.31+ 和 registry 网络。取得统一发布包后，在其目录执行：

```sh
node install.mjs --yes
```

安装器一次配好服务、独立插件依赖根、匹配 Pi 控制台和专属 profile；不要求源码构建，不复制 node_modules，不修改个人 Pi 或系统 PATH。按回执启动 `pi.mjs`，在项目中输入 `/superagent` 即可进入原有初始化/认证向导。Windows 使用原生 Node/Git，不用 WSL；服务/模型/派单/自启各自确认。

详见 [跨机器安装指南](docs/installation.md)。开发者用 `npm run release:bundle` 生成目录，`npm run test:install -- --bundle .artifacts/release --audit` 验证实际安装。当前尚未公开发布 npm/下载站；本地生成的发布目录可直接转移到目标机。历史实例迁移与全新安装分开处理。

## 从源码本地运行

需要 Node.js 24+、npm、Git，以及至少有一个提交的目标仓库。

```sh
npm ci --ignore-scripts
npm run build
node packages/server/dist/cli.js init --repo /absolute/path/to/repository --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js serve --state-dir /absolute/path/to/instance
```

打开 `http://127.0.0.1:4317` 即可使用，新实例默认本地模式，不生成管理 Token。在“设置”页分别填写 Router 与 Worker 的提供商/型号，点击“加载型号目录”从实例固定 SDK 读取候选；认证在 Pi 的 `/superagent models` 中完成。也可以使用 `model router PROVIDER MODEL` 和 `model worker PROVIDER MODEL` 命令。

本地模式仅监听 loopback，信任本机进程；写 API 需要 `Content-Type: application/json` 和 `X-Superagent-Local: 1`。共享机器可使用 `init --management token` 保留管理认证，并限制实例目录权限。已存在的旧实例维持 token 模式：在 Pi 中运行 `/superagent local`，确认后自动停止、切换并启动，无需先登录 Web。CLI 可在服务停止后运行 `management local|token --state-dir PATH` 切换；模式保存在 `management.json`，独立于模型认证、业务配置和 GitHub PAT。

配置页可分别填写团队的沟通、范围与交付约定。已运行工单收到指令更新，匹配规则正文跟随派工和后续输入。团队约定与全部规则正文合计限 32000 字符；根 `AGENTS.md` 同样限 32000 字符，相关子目录指令由 Worker 按需读取。

模型认证使用实例专属 `agent/auth.json`；未托管的前台/detached 服务也支持启动时的提供商环境变量。systemd 托管不继承终端凭据，使用实例文件；代理/CA/PATH 使用私有 `service.env.json`。兼容端点配置在 `agent/models.json`，格式遵循 Pi 的 models.json。服务不会复制个人 Pi 凭证、加载个人扩展或 MCP。模型设置在新的子进程启动时生效；已有进程可通过重启服务应用新配置。

Agent 的 HOME/USERPROFILE、GH_CONFIG_DIR、XDG 等配置目录指向 `agent/home`。模型提供商变量供 SDK 使用，不传给后台命令；GitHub/管理员令牌和个人 SSH agent 也不进入命令环境。后台命令的构建工具与 Git 凭据需在实例目录单独配置，结果回复统一经 Router/Outbox，不能通过 `gh` 或 shell 代发。

模型子进程支持 HTTP_PROXY/HTTPS_PROXY 及小写形式，并遵守 NO_PROXY；在 SDK 导入后重新初始化代理。显式设置 `NODE_USE_ENV_PROXY=0` 可禁用。代理模式已验证 Node 24.14.1；请将 `localhost,127.0.0.1,::1` 加入 NO_PROXY。OAuth 登录成功后，还应核验订阅接口实际支持的模型，SDK 目录中存在的型号可能被接口拒绝。

```sh
node packages/server/dist/cli.js request "实现目标及验收条件" --id request-001 --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js status --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js tickets --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js followup TICKET_ID "补充约束" --id followup-001 --state-dir /absolute/path/to/instance
```

`request` 返回已持久接收的 Trigger，Router 随后创建 Ticket。重试网络请求时复用 `--id`，避免创建重复工单。Web 提交会显示请求编号及暂停/模型未配置提示；在 Router 接单前可用“查看已提交请求”查记录。提交中防重复点击，响应丢失后手动重试相同内容会复用编号。

- `pause` / `resume`：暂停或恢复派发，不打断已经运行的模型步骤。
- `stop TICKET_ID`：撤销该工单的授权并停止执行；新工作需要新的派单。
- `retry TICKET_ID`：重试可重试的失败工单。
- 已正常完成工单的人工跟进可由领域规则重新开启。

停止前台服务后，可改为后台启动：

```sh
node packages/server/dist/cli.js start --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js shutdown --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js backup /absolute/path/to/backup --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js backup-check /absolute/path/to/backup
# restore / backup-prune 默认预检，明确操作加 --yes；完整步骤见 docs/backup.md
```

备份要求服务已停止，托管实例还须 disable；包含数据库、会话、凭据和工作目录，需私密/加密保存。恢复只到同主机/同账户的不存在原路径，保留身份和暂停状态，不启动服务或恢复系统托管；外部 Git 管理区需匹配。保留清理至少留一份，只处理本实例的完整快照。当前不自动清理工单/worktree 或迁移数据库；未知 schema 拒绝。多个实例必须使用不同目录和端口，初始化时用 `--port` 指定。

## SSH 云端服务

在**本机 Pi** 运行 `/superagent ssh`，选择 SSH 主机、远端 Node/服务包及已有 checkout，创建或连接远端实例。新实例采用 token 管理、单 Worker、暂停派单；用 `/superagent models` 配置远端模型，`/superagent web` 通过隧道打开控制台。

`connect` / `disconnect` 管理连接；`start` / `restart` / `shutdown` 经确认管理远端服务。关闭 Pi 或隧道不停止云端任务。远端需预装 Node 24+、Git 和同版服务包；不自动上传代码/未提交改动，不开放公网管理端口。首版远端为 Linux，本机转发与远端服务使用相同端口。完整准备、OAuth 回调和故障说明见 [SSH 使用指南](docs/ssh.md)。

## 多仓库应用工作区

在应用根目录（例如 `~/projects/my-app`）启动 Pi，运行 `/superagent setup`，选择创建实例 → **整个工作区** → 确认仓库集合。根目录本身是 Git 仓库时，选“以工作区模式创建”，包含其嵌套服务。一个需求只提交一次，由同一实例协调各仓库。

CLI 也支持只读发现与初始化：

```sh
node packages/server/dist/cli.js discover --repo "$HOME/projects/my-app"
node packages/server/dist/cli.js init --workspace --repo "$HOME/projects/my-app" \
  --state-dir "$HOME/.pi-superagent/my-app-workspace" --paused --max-workers 1
# 可重复 --member 相对路径，只注册所需仓库；根仓库用 --member .
node packages/server/dist/cli.js workspace --state-dir "$HOME/.pi-superagent/my-app-workspace"
node packages/server/dist/cli.js workspace TICKET_ID --state-dir "$HOME/.pi-superagent/my-app-workspace"
```

`workspace` 查询要求服务在线。工作区实例目录必须位于应用根之外。成员与根路径在创建后固定；现有单仓库实例保持原配置，不自动迁移。

需要直接修改原仓库并保留现有分支时：先在 Web 暂停派单 → 打开工单 → **切换到原工作区执行** → 核对目录、分支和未提交状态后确认 → 单独恢复派单。旧隔离文件保留；原目录执行按仓库加锁，不自动切换分支或清理用户改动。聊天回复不会自动完成配置切换。待确认问题会在 Web 顶部及已连接 Pi 会话主动提示；回复后显示“补充已接收，待处理”。

默认隔离执行：首次执行前保存各成员 HEAD，再按原相对布局创建工单 worktree；重试沿用原基线。子仓库当前 HEAD 与父 gitlink 的已有差异单独显示，显式暂存 gitlink 才计入父仓库变更。Worker 加载工作区根 `AGENTS.md` 和成员 `AGENTS.md`（无则读 `CLAUDE.md`），按目录标明范围，总预算 32000 字符。

Web“工作区”查看成员，工单“仓库变更与验证”查看分仓库改动与检查结果。当前多仓库使用本地派单，代码远端可以是 GitLab；跨仓库 GitHub 来源/PR、GitLab Issue/MR 渠道和原地执行尚未接入。详情见 [多仓库规范](docs/superpowers/specs/2026-11-04-multi-repository-workspace.md)。

## 与开源原型对齐

领域 core 与 DeepSeek 参考版本一致；本轮补齐监督台的主要交互及本地沟通渠道，见 [对齐规范](docs/superpowers/specs/2026-11-04-upstream-panel-alignment.md)。完整提示词模板/技能编辑、默认版本升级合并，以及 DSH 专有 preset/子 Agent 执行能力仍待 Pi 适配。

更新本地代码并构建后，在目标项目 Pi 中先 `/reload`，再 `/superagent restart` 并确认，最后刷新 Web。本轮新增服务 API 和静态模块，需要重启服务；旧服务会显示更新指引。重启保留现有配置、工单和暂停状态。

## GitLab 与本地需求

**代码存放在哪个平台，与从哪里接需求是两件事。** GitLab 仓库的本机 checkout 可以照常作为执行工作区，用 Pi/Web 提需求并在工单里沟通，不需要 GitHub 账号、PAT 或迁移仓库。GitLab Issue/MR 自动接单和回复尚未接入，详见 [GitLab 使用说明](docs/gitlab.md)。

## GitHub（可选）

在 Web“来源”页填写 `owner/repository`、机器账户登录名、明确请求允许名单，启用 GitHub。凭证放在实例的 `github.token`（POSIX 下设为 `0600`），或启动服务时显式设置 `PI_SUPERAGENT_GITHUB_TOKEN`。该凭证与管理 API 的 `admin.token` 不同。

使用专用机器账户的细粒度 PAT，限定本仓库。入站需要 Metadata / Contents / Checks / Commit statuses 读取权限；评论与 PR 操作需要 Issues / Pull requests 写入权限。服务核验 `/user` 与配置身份，默认从启用时开始读取，不导入旧讨论。Agent 工具和指令按启动时的渠道能力装配；启用状态变化后，请显式重启服务更新已有 Agent。关闭来源后宿主立即拒绝相关操作。

```sh
node packages/server/dist/cli.js sources --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js github poll --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js decisions --state-dir /absolute/path/to/instance
node packages/server/dist/cli.js diagnostics TICKET_ID --state-dir /absolute/path/to/instance
```

首轮支持 github.com 和机器账户 PAT。GitHub App 安装令牌、Enterprise 端点尚未接入。Git 推送凭证需要管理员另外配置到实例 `agent/home/.gitconfig` 等受控位置；默认禁用个人 SSH 身份自动选择，服务的 REST PAT 不会自动写进 Git credential helper。详细权限、评估和 PR 工作流见 [GitHub 接入说明](docs/github.md)。

## Pi 插件

宿主 Pi 需要 1.5+（1.x），插件复用宿主 SDK/TUI。构建后一次性安装本地插件：

```sh
pi install /absolute/path/to/dsh-super-agent/packages/extension
```

进入目标项目启动 Pi，输入 **`/superagent`**。已打开的 Pi 使用 `/reload`。向导引导选择单仓库或整个工作区、实例目录和端口，经确认启动服务，再选择模型并独立登录；OAuth 会尝试自动打开浏览器，并保留手动链接；默认 GitHub 关闭、1 个 Worker，配置阶段暂停派单。可选择一次简短模型验证，再确认恢复派单。

`/superagent setup` 可重新配置或连接已有实例。项目绑定保存在用户私有目录，不写入仓库；下次进入同一项目，或工作区内已注册仓库的子目录，会自动找到它，无需每次设置环境变量。任务默认从已提交 HEAD 创建独立 worktree，不包含当前未提交修改；本地 Git 仓库不需要 GitHub 账号、PAT 或远端。

Web 地址固定显示在 Pi 连接栏；即使模型登录取消也会保留。使用 `/superagent web` 或菜单“打开 Web 控制台”：本地模式直接打开，token 模式用一次性授权自动登录；`/superagent web url` 只查看地址。token 模式下可用 `/superagent token` 私密查看/复制管理凭据。本地模式菜单不显示令牌入口。打开 Web 不会启动或重启服务。

旧实例运行 `/superagent local`，在插件内确认切换为本地模式并重启。模型 OAuth 仍独立完成：等待自动回调，或在遮罩框粘贴授权码/完整回调地址；Esc 先确认取消。模型登录不是打开本地 Web 或重启服务的前提。

`/superagent restart` 或菜单“重启后台服务”会展示目标实例、暂停状态和忙碌 Worker 数，经确认后等待旧服务退出再启动并验证连接。管理已绑定的本地或 SSH 实例；保留配置和工单，不自动改变暂停状态或管理模式。管理请求使用独立的本机 HTTP 连接，不经过宿主 Pi 的模型 fetch/代理。

保留 `/superagent status`、`workspace [ID]`、`request 任务描述`、`tickets`、`show ID`、`followup ID 内容`、`stop ID`、`retry ID`、`sources`、`decisions`、`triggers`、`diagnostics ID`。模型工具提供任务操作，不代替用户初始化或登录。关闭 Pi 不会关闭后台服务。

没有项目绑定时仍可用 `PI_SUPERAGENT_HOME`，以及 `PI_SUPERAGENT_URL` / `PI_SUPERAGENT_TOKEN_FILE` 连接服务。项目绑定优先；环境连接指向其他项目时，命令写操作先要求确认，模型工具不能自行批准。远端优先使用 `/superagent ssh` 建立明确绑定；旧手工 SSH 隧道和环境连接仍可用于 API 访问，但不授予本机生命周期所有权。详细流程和服务包定位见 [插件说明](packages/extension/README.md)。

## 验证

```sh
npm run check
npm run test:integration
npm run test:package
npm run test:security
npm run test:stability -- 20
npm run test:web
# Linux，可选：临时 Docker + 真实 OpenSSH/Chromium
npm run test:ssh
# 单独运行 Linux unit / launcher 崩溃恢复（已包含在 integration，不注册宿主服务）
npm run test:supervision
# 单独运行真实临时 CLI 备份/校验/原路径恢复（已包含在 integration）
npm run test:backup
# 单独构建并验证跨平台发布目录（实际 npm 安装、SDK 插件引导，无付费调用）
npm run test:install
```

- `check`：TypeScript、领域及适配器测试、两个包的构建。
- `test:integration`：真实 Pi SDK 子进程连接本地脚本化模型和 GitHub REST 模拟端点，验证入站 → Router → Worker → Router 受控回复、提问后人工跟进停止、静默规则传递、项目指令、无唤醒背景通知、Session 和重启去重；分别在默认隔离与显式原目录模式下，用真实 SDK Worker 修改前端和嵌套后端、运行 Node 跨仓库一致性检查、提交整体/分仓库报告并重启核验。模型响应由本地脚本提供，无付费模型或真实 GitHub 写入。另在 Linux 验证 SSH stdio 控制桥、远端生命周期和隔离 SDK 测试认证；校验 systemd unit，并对临时 launcher 执行实际进程崩溃、等待锁过期和持久状态恢复。第二次启动由测试脚本驱动，不向宿主注册 unit。另以真实临时 CLI 验证离线快照、预检、原路径恢复、凭据/会话/工作文件和请求幂等；单元回归使用真实 SDK 核验恢复后仍选择同一最近会话。
- `test:install`：生成或消费统一发布目录，在空 HOME 中以原生 npm ci 安装两个隔离依赖根，验证真实 Pi RPC 插件注册、SDK 加载后的向导/遮罩测试 key、CLI/Web/请求幂等/Node Job 和停止；`--audit` 审计两个真实安装根。CI 六个 OS/架构目标消费同一份 artifact，全部安装与常规测试通过才输出 verified artifact。
- `test:package`：打包两个 npm tarball，在独立目录安装，验证 CLI、Web、后台启动/停止、备份，以及已安装插件的多仓库向导/CLI 发现、实例 SDK 认证 IPC、私密输入遮罩和成员目录连接继承。另验证 token 模式登录、无 Token 的本地重启、旧实例切换本地模式、删除测试 Token 后再次重启及状态保留。模型认证使用测试 API key，不发起付费模型请求。会从 npm 下载依赖，不会发布包。

- `test:security`：公开 npm registry 审计项目生产树，再执行带审计的安装包测试；单独安装插件不会安装 SDK/TUI，服务消费者实际树固定为已修复版本。任何审计发现或 registry 错误均导致失败。
- `test:stability`：重复 coordination/driver/remote-control/supervision/backup/install/stale-lock-grace 七个定向套件，默认 20 轮；遇到首个失败即退出，不自动重试。每轮详细日志保存在 `.artifacts/stability-*`，CI 每个平台运行 10 轮并上传日志。回归包含时钟回拨时的持久通知、到期去重，以及端口占用拒绝；调查见 [安全升级与稳定性](docs/superpowers/specs/2026-11-05-sdk-security-stability.md)。
- `test:web`：真实 Chrome/Chromium 验证暂停/模型未配置时的提交回执、请求记录、超时与丢失响应幂等重试，以及登录、CSRF、GitHub 配置和健康、派单/筛选/停止、待人工事项与直接回答、团队约定、运行诊断、记录浏览及安全文本显示；另验证本地模式直接进入、无登录/退出控件、无 cookie 刷新和写操作，并展示真实 SDK 跨仓库任务的成员、gitlink 基线、变更与验证结果。本机可用 Chrome；其他环境先运行 `npx playwright install --with-deps chromium`，或设置 `CHROME_PATH`。

自动化测试使用模拟 GitHub；另已完成私有测试仓库的真实只读模型任务、机器账号结果评论及重启去重。代码推送、PR 生命周期和更复杂协作继续联调。插件向导有离线自动化验证，实际浏览器 OAuth 和完整交互式 TUI 验收仍待完成。

## 结构与边界

- [`packages/server`](packages/server)：服务、CLI、静态 Web、Pi SDK 执行适配。
- [`packages/extension`](packages/extension)：轻量 Pi package，无服务运行依赖。
- [本地与 SSH 目标、设计和交付顺序](docs/superpowers/specs/2026-11-04-local-ssh-design.md)
- [需求与设计](docs/superpowers/specs/2026-11-02-pi-superagent-design.md)
- [本地管理模式与旧实例转换](docs/superpowers/specs/2026-11-04-local-management-mode.md)
- [上游架构调研](docs/research/deepseek-superagent-architecture.md)
- [实施状态](docs/superpowers/pi-superagent-design-status.md)
- [协作语义校准](docs/superpowers/specs/2026-11-02-superagent-alignment.md)

Worker 以服务账户权限执行文件和进程操作。使用专用账户或隔离环境，限制可访问的凭据与网络；worktree 和独立 Node 进程不提供系统沙箱。

领域内核和原始领域测试来自 DeepSeek MIT 项目，固定提交 `6337fc823ce20251c8de8085948165c81aaa701e`。归属见 [THIRD_PARTY_NOTICES](packages/server/THIRD_PARTY_NOTICES.md)。`upstream/` 为可选的本地研究参考，不进入源码提交或发行包，构建和测试不依赖该目录。产品源码仓库：[Nemotte/pi-superagent](https://github.com/Nemotte/pi-superagent)。
