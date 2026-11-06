# 在本机 Pi 中管理 SSH 服务

插件可以管理本机实例，也可以通过系统 OpenSSH 管理远端 Linux 实例。仓库、worktree、SQLite、会话和模型凭据均留在执行主机；本机 Pi 负责派单、沟通和查看结果。两种方式都不需要 GitHub。

## 准备远端

首版要求远端已有：

- Linux、Node.js 24+、Git。
- 与本机插件同版的 `@pi-superagent/server` 服务包。
- 至少有一个提交的 Git checkout；多仓库应用准备好需要参与的成员。
- SSH 公钥/agent 免交互认证，主机指纹已由用户核对。

服务包可以复制可信构建产物或通过 tarball 安装，不需要 GitHub 账号或仓库。当前版本尚未发布 npm，可在开发机先构建、打包，再把服务 tarball 传到远端独立安装目录：

```sh
# 产品工程内
npm ci --ignore-scripts
npm run build
npm pack --workspace @pi-superagent/server

# 用户将 tarball 复制到远端后，在远端独立安装目录运行
npm install --ignore-scripts /absolute/path/pi-superagent-server-0.1.0-alpha.1.tgz
```

安装后的 CLI 通常为 `/absolute/install-dir/node_modules/@pi-superagent/server/dist/cli.js`。插件会使用旁边的 `remote-child.js` 控制桥。不要将实例目录放进服务包、应用仓库或工作区；使用类似 `/home/me/.pi-superagent/my-app` 的私有目录。

在本机终端先验证 SSH：

```sh
ssh my-cloud
# 确认实际主机指纹、认证方式，以及远端 node --version / git --version
```

推荐在本机 `~/.ssh/config` 配置别名、用户名、端口、IdentityFile 和可选 ProxyJump。插件输入别名即可；IPv6 地址也请通过别名配置。为插件使用只包含连接/身份配置的专用别名，不配置额外 LocalForward/RemoteForward。插件不接受自由 SSH 参数，也不提示输入服务器密码；加密私钥可先加入本机 SSH agent。

插件启用 `StrictHostKeyChecking=yes`、`BatchMode=yes`，禁用 agent/X11 forwarding、共享 ControlMaster 和 LocalCommand。管理 SSH 可以使用本机 SSH agent；其 socket 不进入远端 Worker。传给 SSH 的本机环境仅保留系统运行、用户目录、locale 和 SSH agent 字段，不传模型/管理/渠道凭据。

## 首次连接

在本机希望作为入口的项目目录启动 Pi，执行：

```text
/superagent ssh
```

也可以在 `/superagent setup` 中选择“通过 SSH 管理远端服务”。向导依次询问：

1. SSH 主机别名或 `user@hostname`。
2. 远端 `node`，或 Node 的绝对路径。nvm 的非交互 SSH PATH 可能找不到 node，建议填写 `/home/me/.nvm/versions/node/v24.x.x/bin/node`。
3. 远端服务包 `dist/cli.js` 的绝对路径。
4. 连接已有实例，或在已有 checkout 创建单仓库/多仓库实例。
5. 实例目录和项目绑定确认；离线实例另外确认启动。

新实例：**token 管理、单 Worker、暂停派单、GitHub 关闭**。已有实例保留配置。远端若使用 local 管理模式，用户需先在远端停止服务并运行 `management token --state-dir PATH`，再连接；插件不会自动转换管理模式。

创建多仓库时，发现和成员选择都发生在远端。任务从远端各仓库的已提交 HEAD 创建隔离 worktree；本机修改、远端 checkout 的未提交修改都不会自动带入任务。插件不克隆、不拉取、不修复 submodule，也不负责本机与云端的代码同步。

本机绑定只保存项目入口、SSH 目标和远端实例身份，不保存管理 token。远端 binding 的路径按远端解释，不要求本机有对应目录。首版远端绑定关联当前本机项目入口，不自动推断其成员目录与远端仓库的映射。

## 模型与任务

```text
/superagent models
/superagent web
/superagent request 实现目标、约束和验收条件
```

`models` 在本机显示选择和私密登录 UI，实际 SDK 和认证文件位于远端实例。可以分别选择 Router/Worker；模型验证会单独询问，恢复派单也会单独确认。只有认证或目录读取成功时，不会把它报告成推理验证成功。

OAuth 页面在本机浏览器打开。如果提供商使用远端 localhost 回调，本机浏览器不能直接访问该回调服务；登录后复制浏览器最终回调地址到 Pi 的遮罩框。设备码登录按提供商页面提示操作。插件不转发 OAuth 固定回调端口，也不复制本机 Pi 的认证文件。

`web` 通过 SSH 隧道打开控制台，用 60 秒一次性授权兑换 cookie。长期管理 token 只经 SSH 到插件内存，不进入 URL、argv、聊天、绑定文件或日志。关闭浏览器不影响服务运行。

## 日常命令

| 命令 | 作用 |
| --- | --- |
| `/superagent connect` | 连接已绑定远端，建立 SSH 隧道，不启动服务 |
| `/superagent disconnect` | 断开本机隧道，远端服务和任务继续运行 |
| `/superagent start` | 确认后启动远端实例；已运行则保持原状 |
| `/superagent restart` | 确认后重启当前绑定实例，保留模型、工单和暂停状态 |
| `/superagent shutdown` | 确认后停止远端服务，数据保留 |
| `/superagent web url` | 只显示本机转发地址，不建立连接 |
| `status` / `tickets` / `show` / `request` / `followup` / `stop` / `retry` | 复用已绑定实例的任务 API |

上述 `start`/`shutdown` 插件命令用于 SSH 实例。本地实例继续使用 `restart` 启动/重启，或 CLI 的 `start`/`shutdown`。

已绑定远端的普通用户命令可以建立连接，但不自动启动后台服务。模型工具只能复用用户已连接的实例，不能发起 SSH、登录、安装、启动或重启。

Pi 加载/会话启动只显示连接信息，不发起 SSH。退出、`/reload` 或切换会话时，插件关闭自己持有的隧道及认证进程；远端常驻服务继续运行。网络断开后运行 `/superagent connect`；不会自动重启服务或重发写请求。API 请求的幂等 ID 和持久记录沿用本地实现。

## 端口、更新和故障

首版转发使用**与远端服务相同的本机端口**，例如 `127.0.0.1:4317 → SSH → 127.0.0.1:4317`，保留精确 Host/Origin 校验。新实例自动选本机空闲端口并在远端检查。已有实例若该端口已被本机其他程序使用，连接会拒绝；请释放该端口，不要停止不属于本实例的服务。首版不支持任意不同端口映射。

- `SPAWN`：本机找不到或不能运行 ssh。
- `DISCONNECTED`：检查终端 SSH、known_hosts、密钥解锁、远端 Node 和服务包路径；不把远端 stderr 原文带入聊天。
- `TOKEN_REQUIRED`：远端实例需显式使用 token 模式。
- `IDENTITY`：实例 ID、仓库或端口已变化，重新运行 `/superagent ssh` 核对并绑定。
- `INSTANCE_BUSY` / `STOP_TIMEOUT`：检查远端实例锁、端口和 `service.log`；插件不强杀服务、不删锁、不启动第二个实例。
- `MODEL_FAILED`：检查远端模型网络、认证方式和账号支持型号；实例保持暂停，不自动重试付费探测。

当前服务固定 SDK 1.5.0，本机宿主 Pi 要求 1.5+（1.x）。更新时先构建/安装本机插件和远端同版服务包，并确认远端依赖也已更新；仅本地 build 不会升级云端。更新宿主 Pi 后重新启动 Pi，`/reload` 加载插件，再 `/superagent restart` 确认重启远端，最后刷新 Web。源码 SSH 管理入口需要新版服务包中的控制桥，旧版仅支持手工隧道。

默认 `start` 仍为 detached。Linux systemd 245+ 可以先 `/superagent shutdown`，再分别 `/superagent service install`、`/superagent service enable`、`/superagent start`，每步单独确认；注册不启动、enable 不顺带启动。`service status` 查看 manager 状态。SSH 通过受限控制桥执行这些操作，不传自由 systemctl 参数。详见 [systemd 指南](systemd.md)。无登录开机运行需要管理员另行配置 linger；真实 manager/开机验收尚待部署环境执行。云端建议用专用 OS 用户，限制仓库、实例目录和网络权限；Worker 具有该用户的文件/进程权限。

## 执行主机统一安装

Linux 远端可使用 [统一发布包](installation.md)在准备 Node 24+/npm/Git 后执行一次 `node install.mjs --yes`。SSH 向导使用安装回执中的 `node` 与 `serverCli`；不要填包装入口 superagent.mjs。安装过程不由插件自动执行，不配置 SSH 信任、clone 仓库或启动实例。本机客户端可在 Windows/macOS/Linux 安装，首版远端执行宿主仍限定 Linux。

## 备份与升级

在远端执行主机运行 `backup`、`backup-check`、`restore` 和 `backup-prune`；这些运维动作不经过插件控制桥，不向聊天传输快照/凭据。按 [备份指南](backup.md)先暂停、停机，托管实例另行 disable。当前恢复限定原主机、账户和不存在的原路径，外部仓库及 Git 管理区需匹配；不自动启动、恢复托管、上传代码或迁移到新主机。

## 验证

- 单元测试覆盖绑定、角色模型入口、仅用户命令可连接/控制、参数引用/注入、SSH 环境隔离、超时/取消/输出上限、端口冲突、断线后的旧 Client 拒绝、身份校验及秘密不落盘。
- `npm run verify` 包含 `scripts/ssh-smoke.mjs`：Linux 临时实例的真实 stdio 控制桥、SDK 目录/测试 API key、启动/重启/关闭、暂停和请求保留。其他平台跳过 Linux 执行宿主用例。
- Linux 上额外运行 `npm run test:ssh`：临时 Docker Ubuntu + 真正 OpenSSH、临时密钥/known_hosts，验证错误主机密钥拒绝、控制桥、token API 和 Chromium Web 隧道、连接断开/恢复、显式重启和关闭。需要 Docker、ssh/ssh-keygen 和 Chromium；可能下载 Ubuntu 和安装测试容器依赖。

容器测试不使用个人 SSH 私钥、真实云服务器、付费模型或 GitHub。真人云端 OAuth 和完整 Pi TUI 仍需实际环境验收。
