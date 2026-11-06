# 新机器一次安装

统一发布包用于 **Linux、macOS、Windows 原生环境的全新安装**。不需要克隆开发仓库、运行 TypeScript 构建、分别安装服务/插件或手填本机服务路径。两个 npm 包仍独立发布；统一安装器把它们配成可运行的控制台。

## 1. 系统前置条件

- Node.js **24+**，含 npm **10+**。推荐 Node 24 LTS 的官方完整安装包或正常的版本管理器安装；仅下载 node 可执行文件不包含 npm。
- Git **2.31+**，在 PATH 中。Windows 安装 Git for Windows 并允许命令行使用 Git；不需要 WSL。
- 可访问 `https://registry.npmjs.org`。支持现有 HTTP(S) 代理和 CA 环境；发布包不包含离线依赖镜像。
- x64/arm64 为目标架构；各平台验收状态见文末。

产品不会自动 sudo、安装系统 Node/Git、修改 PATH/注册表或启用开机服务。工程需要的 Java、Python、数据库等运行环境，按工程本身准备。

## 2. 一条命令安装

从可信来源取得并解压统一发布包，进入包含 `install.mjs` 的目录：

```sh
# 可选：只预检 Node/SQLite/Git/npm、包完整性和安装目标
node install.mjs

# Linux / macOS / Windows PowerShell 均相同
node install.mjs --yes
```

默认安装到用户主目录的 `.pi-superagent/application`。也可指定绝对路径（支持空格和中文）：

```sh
node install.mjs --yes --destination "/absolute/path/Pi Superagent"
```

Windows 示例：

```powershell
node install.mjs --yes --destination "$env:LOCALAPPDATA\Pi Superagent"
```

如果 npm 使用特殊布局，显式传 `--npm-cli` 指向 `npm/bin/npm-cli.js`，不是 npm.cmd。安装器用当前 Node 直接执行 npm CLI；不会把路径或参数拼成 shell 命令。

目标目录必须不存在。已有目录无论属于其他应用、旧安装或中断安装，都不会被覆盖。安装完成输出 `installed: true`、两个启动入口、实际 `serverCli` 和 `node` 路径。安装期间不会创建业务实例、启动服务、登录模型或产生推理费用。

## 3. 首次使用

进入 Git 仓库或包含多个仓库的工作区（每个执行成员至少一个提交），运行安装回执中的 Pi 入口。默认路径示例：

Linux/macOS：

```sh
cd /path/to/project
node "$HOME/.pi-superagent/application/pi.mjs"
```

Windows PowerShell：

```powershell
cd C:\work\project
node "$HOME\.pi-superagent\application\pi.mjs"
```

然后输入：

```text
/superagent
```

向导选择单仓库/工作区、实例位置和端口，分别确认创建、启动、模型认证/验证和恢复派单。没有模型凭据也可以先打开控制台和向导；认证由用户完成，保存在执行主机的实例中。

CLI 使用另一个入口：

```sh
node "$HOME/.pi-superagent/application/superagent.mjs" --help
```

服务包位于 `INSTALL/runtime/node_modules/@nemotte/pi-superagent`。SSH Linux 执行主机也可使用同一发布包安装；在本机 Pi 的 SSH 向导中填安装回执中的 **node 和 serverCli**，不是 superagent.mjs 包装入口。仓库 checkout、SSH 信任和密钥仍由管理员准备，见 [SSH 指南](ssh.md)。

## 安装布局与现有 Pi

```text
INSTALL/
  runtime/node_modules/    服务 + 固定 SDK 1.5.0（同时提供 Pi CLI）
  client/node_modules/     仅插件，没有物理 SDK/TUI 副本
  profile/                独立 Pi 控制台配置、会话及用户后续保存的认证
  packages/               两个原始 tarball
  pi.mjs                  原生 Node 控制台入口，自动配置服务路径
  superagent.mjs          原生 Node 服务 CLI 入口
  installation.json       安装完成、版本、路径、OS/架构记录
```

服务与插件分开依赖根，避免编译后的 ESM 插件绕过 Pi 的宿主模块映射。控制台直接使用服务已固定的上游 Pi CLI，没有 fork SDK，也没有给插件增加 SDK 依赖。

个人 `~/.pi/agent` 不读取、复制或修改；已有 Pi、插件和后台实例保持原状。新控制台自己的设置位于 INSTALL/profile。业务实例和管理绑定仍在既有 `~/.pi-superagent/` 布局，不随安装自动升级。也可以继续使用原有的宿主 Pi + 插件安装方式，见根 README。

不要直接跨 OS/架构复制已安装目录或 node_modules；将**发布包**带到目标环境重新执行安装器。安装路径变化也需要重新安装，因为 Pi 包登记使用绝对路径。

## 网络、权限与失败

- npm 使用锁定的生产依赖和 integrity，关闭生命周期脚本，固定 prefix 并禁用上层 workspace 推断，不改上层工程，不需要本地编译工具链。
- 安装子进程只保留系统、代理和 CA 环境，不继承用户 npm registry/auth 配置、模型密钥、SSH agent 或 NODE_OPTIONS。企业环境可用 HTTPS_PROXY / NODE_EXTRA_CA_CERTS，安装仍从公共 registry 获取锁定包。
- POSIX 安装根和 profile 为 0700。Windows 默认使用用户主目录；自定义共享目录需要账户受限 ACL。
- 未确认只预检，不写安装目录。普通失败清理本次创建目标；强制中断可能留下 `.installing`，入口拒绝启动。确认安装进程已退出后，保留诊断或移走该目录，再安装到不存在的目标。
- 安装完成前实际通过 SDK 加载插件并核验 `/superagent` 注册，不只看版本号；成功后删除临时 npm 配置/缓存。
- 安全错误阶段码如 INSTALL_RUNTIME、INSTALL_GIT、INSTALL_NPM、INSTALL_INTEGRITY、INSTALL_NPM_RUNTIME、INSTALL_REGISTER、INSTALL_PLUGIN；不会将任意 npm stderr 或代理凭据打印出来。
- 无自动重试。网络恢复后由用户再次执行安装；不会把部分成功报告为完成。

## 升级、迁移和自启

首版统一安装器负责全新安装，不原地覆盖升级。保留旧安装与 profile，在新目录安装后，按 [备份/升级指南](backup.md)显式处理实例及重启；systemd 登记绑定旧 Node/CLI 路径，改路径前按 [托管指南](systemd.md)卸载旧登记再注册。

全新跨系统安装不等于跨系统恢复历史实例。旧 SQLite/session/Git worktree 的路径及外部 Git 管理区迁移仍需独立功能；本轮没有放宽原路径备份恢复限制。macOS/Windows 原生系统托管仍待实现，当前可运行独立后台服务。

## 生成发布包与验收

开发者在源工程运行：

```sh
npm ci --ignore-scripts
npm run release:bundle
# 输出 .artifacts/release；已有输出不覆盖
npm run test:install -- --bundle .artifacts/release --audit
```

构建从已验证工作区 lock 生成生产锁，剔除开发依赖，将已知镜像 tarball URL 规范化到公共 registry，同时保留原 integrity；拒绝依赖版本/摘要漂移。发布目录没有 node_modules，复制到目标机器后按目标 OS 安装。

CI 一次生成 `portable-candidate`，由 Linux/macOS/Windows × x64/arm64 六个独立 runner 消费同一个 artifact。消费者不执行工作区 npm ci/build；检查原生安装、Pi RPC 中的真实插件注册、SDK 加载后的完整引导/遮罩测试 key、CLI/Web、Node Job、退出与两个安装根审计。只有常规测试和全部安装矩阵通过，才产生 `portable-verified` artifact；不自动发布 npm。

[CI 运行 42171893012](https://github.com/Nemotte/pi-superagent/actions/runs/42171893012)已全部通过（源码 `17ddd95`）：Linux/macOS/Windows 三系统完整检查及各 10 轮稳定性测试，六个 OS/架构组合消费同一构建产物的原生安装与审计。已生成 `portable-verified`。Windows 短路径启动问题已修复；本地另完成 20 轮稳定性测试。两个 npm 包尚未发布。
