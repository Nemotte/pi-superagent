# @pi-superagent/extension

Pi 项目入口，管理本地或 SSH 云服务器上的独立 Pi Super-agent 服务。GitHub 是可选渠道，基础使用不需要 GitHub 账号或 PAT。插件使用宿主 Pi 的 UI；模型认证和后台执行使用执行主机上服务包固定的 SDK。

## 首次使用

当前为未发布的 `0.1.0-alpha.1`。在产品 workspace 构建后，全局安装本地插件：

```sh
npm run build
pi install /absolute/path/to/dsh-super-agent/packages/extension
```

进入目标项目启动 Pi，输入 `/superagent`。已打开的 Pi 可用 `/reload` 重新加载插件。

向导会：

1. 选择单个 Git 仓库或整个应用工作区，并勾选工作区成员。每个成员要求有 HEAD，不自动提交文件或下载缺失模块。根本身是 Git 仓库时，可选“以工作区模式创建”发现嵌套 gitlink 服务。
2. 确认仓库外（多仓库时为整个工作区外）的实例目录和空闲端口，创建本地免登录、GitHub 关闭、单 Worker、暂停派单的实例，不生成管理 Token。
3. 经确认启动独立后台服务。
4. 选择 Router / Worker 共用的初始型号，独立进行 OAuth 或 API key 登录。OAuth 会尝试打开浏览器，链接和进度保留在登录栏；失败可手动打开。等待自动回调，或按提供商说明在遮罩框粘贴授权码/完整回调地址；Esc 先确认取消。不同角色可稍后通过 `/superagent models`、Web 或 CLI 单独调整。
5. 可选发起一次简短模型请求验证，使用少量模型额度；失败保持暂停，不自动重试。
6. 确认是否恢复派单。不会自动提交任务。

也可用 `/superagent setup` 连接已有实例，保留其模型、来源和暂停状态。中途取消后可再次进入向导继续；已创建的实例不会删除或覆盖，连接栏继续显示 Web 地址。

一个工作区实例统一接收需求；一个任务可跨多个成员仓库执行，保留整体结果与分仓库改动/验证。各成员从首次执行时持久保存的 HEAD 创建独立 worktree，按原相对布局装配；重试复用基线，不包含原目录未提交修改。工作区成员创建后固定；当前多仓库使用本地派单，不启用单仓库 GitHub 来源/PR。GitHub、PAT 和远端仓库均不是本地派单的前提。

## 本机 Pi 管理 SSH 远端

运行 `/superagent ssh`，填写已有 SSH 别名/user@host、远端 Node 和服务包 `dist/cli.js` 的绝对路径，选择创建或连接实例。远端需已有 Linux、Node 24+、Git、同版服务包和带 HEAD 的 checkout；不自动安装软件、同步本机代码或下载缺失仓库。首版使用与远端服务相同的本机转发端口。

新实例默认 token 管理、单 Worker、暂停派单；已有实例保留设置。模型配置仍用 `/superagent models`，SDK 和凭据位于远端；OAuth 本机打开后，必要时在遮罩框粘贴最终回调地址。`/superagent web` 经 SSH 隧道和一次性授权打开控制台，不开放公网 API。

- `connect` / `disconnect`：连接或断开隧道，不改变远端服务运行状态。
- `start` / `restart` / `shutdown`：确认后启动、重启或停止绑定远端，保留数据和暂停状态。
- 会话启动不发起 SSH；模型工具只能复用用户已建立的连接。关闭 Pi、reload、切换会话清理隧道/登录进程，远端服务继续运行。
- SSH 严格检查已有 known_hosts，使用免交互密钥认证，禁用 agent forwarding；本机私钥不复制到远端。管理 token 仅保留于连接内存，不写绑定文件。

完整步骤、部署 tarball、端口限制和排障见 [SSH 指南](../../docs/ssh.md)。

## 已有实例的日常操作

- `/superagent models` 或菜单“配置角色模型”：直接使用当前绑定（包括从工作区成员继承的绑定），选择仅 Router、仅 Worker 或共用型号；不重选仓库、不新建实例。认证和可选验证仍由用户确认，未配置完整保持暂停。
- `status` 显示就绪状态和下一步；`tickets` 在交互模式下先选择工单再显示摘要；提交返回简明回执。完整沟通、结果和设置历史在 Web 阅读。
- 更新代码并构建后，`/reload` 加载插件，再 `/superagent restart` 确认重启以加载新的服务 API，最后刷新 Web。
- GitLab 仓库可以使用本地工作区派单；不要求 GitHub。GitLab Issue/MR 原生渠道尚未接入，代码修改仍位于隔离 worktree。

## 项目连接

绑定保存在 `~/.pi-superagent/connections/`，只记录项目路径、实例目录和实例 ID，不向项目写入连接文件或令牌。再次进入同一项目或已注册成员的子目录会自动找到实例；未注册的邻近/嵌套仓库不会继承工作区绑定；会话启动不会自动创建实例或启动服务。

项目绑定优先于环境变量。没有绑定时，兼容以下连接设置：

- `PI_SUPERAGENT_HOME`：实例目录，默认 `~/.pi-superagent/default`。
- `PI_SUPERAGENT_URL`：本机 HTTP 地址，例如 `http://127.0.0.1:4317`。
- `PI_SUPERAGENT_TOKEN_FILE` 或 `PI_SUPERAGENT_TOKEN`：仅 token 模式需要的管理令牌。

环境连接若指向其他项目，命令首次写操作会要求明确确认；模型工具不能自行确认。本次会话的确认绑定当前项目、端点和实例 ID，新会话重新确认。旧环境连接仍可配合手工 SSH 隧道使用；新的 `/superagent ssh` 向导可创建、绑定并管理远端实例。SSH 绑定中的路径按远端解释，首版不自动推断本机工作区成员与远端目录的对应关系。

## 命令与运行

`/superagent` 打开向导或任务菜单。`/superagent web` 打开浏览器：本地模式直接进入，无 Token、cookie 或登录步骤；token 模式使用 60 秒有效、单次兑换的授权建立 cookie 会话。`/superagent web url` 只显示普通地址，离线可用；`status` 也返回 `webUrl`。保留 `status`、`workspace [ID]`、`tickets`、`sources`、`decisions`、`triggers`、`request TEXT`、`show ID`、`diagnostics ID`、`followup ID TEXT`、`stop ID`、`retry ID` 子命令。

token 模式手动连接其他客户端时运行 `/superagent token`：确认后显示默认遮罩的临时面板，C 复制、V 显示/隐藏、Esc 关闭，60 秒后自动关闭。值不写入聊天、通知或插件日志。Linux 剪贴板使用 `wl-copy`（Wayland）或 `xclip`（X11），macOS 使用 `pbcopy`，Windows 使用 `clip.exe`；没有对应工具时可显示后手动选择复制。自动打开浏览器失败也会在临时面板提供一次性链接，不把长期令牌带入 URL。

**旧实例切换本地模式：** 构建后 `/reload`，运行 `/superagent local` 或选菜单“切换到本地模式”。确认目标和本机信任范围后，插件预检 CLI、停止旧服务、离线修改模式、启动并验证。旧接口使用已有连接退出，不需要先登录 Web。工单、模型、凭据和暂停状态保留；后续重启不读取管理 Token。本地模式信任本机所有进程，不适用于多用户共享机器；共享部署可在服务停止后用 CLI `management token` 启用认证并配置实例目录权限。

`/superagent restart` 显示目标仓库、实例目录、暂停状态和忙碌 Worker 数。确认后先预检本地服务 CLI，再通过当前模式的管理 API 停止服务；等待实例锁释放和端口关闭后启动，并重新校验实例身份。配置、凭据及工单保留，暂停状态不自动改变；运行中的 Agent/子进程会结束，未完成工作按现有机制恢复。等待超时不会强杀进程或删除锁。已停止且端口空闲的实例可确认启动。重启保留访问模式，不依赖 Web 登录、模型 OAuth 或 GitHub PAT；插件本机请求使用独立 Node HTTP 连接，不受宿主模型 fetch、代理 dispatcher 或旧连接池影响。验证失败显示 HTTP 状态或连接错误码，不回显凭据。

重启支持通过向导确认绑定的本地或 SSH 实例。环境变量或自行建立的隧道不授予生命周期所有权；本地使用 `/superagent setup` 绑定，远端使用 `/superagent ssh` 绑定。远端 `/superagent local` 被拒绝，保留 token 管理模式。

模型工具 `superagent` 提供任务操作，不提供初始化、重启、模式切换、登录或令牌操作；工具的 `web` action 只返回普通地址。重试提交时使用稳定的 `requestId`。提交不自动附带前台聊天，应写明目标、约束和验收条件。

关闭 Pi 不会关闭后台服务。停止服务使用 `pi-superagent shutdown --state-dir PATH`；后台启动不自动注册系统服务。Linux 可在停机后使用 `/superagent service` 或 `service install`，确认注册 systemd 用户托管，再单独 `service enable` 启用登录自启、`/superagent restart` 启动。`service status|plan|disable|uninstall` 查看/移除托管；SSH binding 使用同一入口。无登录开机运行需要管理员另行配置 linger。注册后使用实例凭据文件和私有 `service.env.json`，不继承终端凭据。裸 serve 不再用于托管实例。真实 manager 的自动重启/开机运行仍待部署验收。调整已有实例的型号后，已有 Agent 进程需重启服务才能切换；向导不会自动中断活动工单，可另行用 `/superagent restart` 确认重启。

备份与恢复由执行主机 CLI 处理：`backup`、`backup-check`、`restore`、`backup-prune`；SSH 实例在远端运行，不通过 Pi 聊天传输快照或凭据。恢复/清理默认预检，需 UUID 和独立 `--yes`；恢复不启动服务、不恢复系统托管，仅支持同主机/账户/原路径。完整升级和回退步骤见项目 `docs/backup.md`。

## 新机器统一安装

统一发布目录的 `node install.mjs --yes` 一次安装服务、插件及匹配 Pi 入口。使用回执中的 `pi.mjs` 自动定位本机服务，不需要手填 PI_SUPERAGENT_SERVER；控制台使用安装内的独立 profile，不改个人 Pi 配置。插件的 client 依赖根没有 SDK/TUI 副本，SDK 由实际宿主提供。Node 24+/npm 10+、Git 2.31+ 为前置，Windows 不用 WSL；见项目 `docs/installation.md`。安装不启动服务或认证模型。

## 服务包与认证

要求 Pi 1.5+（1.x）/ API v1；SDK/TUI 开发依赖固定 1.5.0，optional peer 下限为 ^1.5.0。升级宿主 Pi 后重新启动 Pi，再 `/reload` 加载插件；已运行服务另外通过 `/superagent restart` 确认加载新版依赖。本地执行时服务包需在本机存在，SSH 执行时只需在远端存在；插件不安装另一份 SDK。初始化优先定位 `@pi-superagent/server/bootstrap`，本地 workspace 可自动发现相邻服务包。其他布局可设置 `PI_SUPERAGENT_SERVER=/absolute/path/to/server/dist/cli.js`。

认证仅写入实例 `agent/auth.json`，不复制个人 Pi/gh 凭据或启动环境中的模型密钥。API key 和手工 OAuth 回调输入采用终端遮罩，通过 IPC 传递，不写聊天或进程参数。兼容端点可预先配置实例 `agent/models.json`。没有交互登录方法的提供商需先配置该实例的凭据。

初始化子进程保留代理和 CA 设置；使用 HTTP 代理时应配置 `NO_PROXY=localhost,127.0.0.1,::1`。实际账号支持的型号可能少于 SDK 目录，建议运行向导中的模型验证。

自动测试覆盖单仓库/工作区引导、真实 CLI/API/SDK 认证 IPC、自动打开链接/遮罩输入/取消语义、固定 Web 入口、一次性登录/cookie/CSRF、私密令牌面板及剪贴板 stdin 传递、成员目录连接继承、本地免登录/缺少 Token 时重启、旧实例转换及干净安装。实际浏览器 OAuth 与完整 Pi TUI 人工验收另行进行。
