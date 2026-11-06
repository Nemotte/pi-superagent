# 跨机器、跨系统的一次安装

## 用户目标与选择

用户将当前主线调整为新机器/其他操作系统的一次安装即用，优先于真实 systemd 部署验收。沿用设计文档化后直接实现、不再拆实施计划或重复审批的约定。产品根没有 Git，不借 upstream 建分支；不操作现有业务实例、个人 Pi 配置或宿主系统服务。

比较三个方案：

1. 继续要求分别安装两个包、配置服务路径：跨安装根解析不稳定，步骤过多。
2. 给插件直接添加 SDK/服务依赖：会让编译后的 ESM 插件看到另一份宿主 SDK/TUI，违背宿主复用原则。
3. **推荐并采用：统一发布目录 + 原生 Node 安装器 + 两个隔离依赖根 + 匹配的 Pi 启动入口。** 两个 npm 包保持独立，不增加第三个 npm 包，也不修改上游 SDK。

## 一次安装的契约

- 前置：Node 24+（含 npm 10+）、Git 2.31+；支持目标 Linux/macOS/Windows 的 x64/arm64。Windows 原生 Node/Git，不需要 WSL。
- 一个发布目录包括预编译的两个 tarball、各自生产 lockfile、完整性清单和独立 install.mjs；不带 node_modules，不要求克隆项目、TypeScript、编译器或 npm scope 已发布。
- `node install.mjs` 只预检/显示目标；`node install.mjs --yes [--destination ABSOLUTE_PATH]` 明确安装。首次安装要求目标不存在，不覆盖已有安装/实例，不自动重试或升级。
- npm ci 在目标系统解析平台可选依赖；禁 lifecycle scripts，锁定全部生产依赖与 integrity。构建时拒绝与已验证工作区依赖版本/integrity 漂移。
- 安装目标有完成标记和平台/架构/产品版本。普通失败仅清理本次创建目录；强制中断保留未完成标记，拒绝当作可用安装。不得直接将已安装目录跨系统复制。
- 完成后有两个原生 Node 入口：`node INSTALL/pi.mjs` 打开匹配 Pi 控制台；`node INSTALL/superagent.mjs ...` 运行服务 CLI。入口使用当前 Node 参数数组启动，不经过 shell，不修改 PATH/注册表，也不依赖 Windows npm.cmd。
- Pi 使用 INSTALL/profile 独立配置，由固定 SDK 的 Pi CLI 注册本地插件。runtime/node_modules 保存服务与固定 SDK；client/node_modules 仅保存插件，不放第二份 SDK/TUI。Pi 入口自动传准确服务路径，免去手工环境变量；个人 Pi 配置/凭据不复制或修改。
- 安装不创建业务实例、不启动服务、不登录、不调用模型、不自动 resume、不注册自启。用户在项目中启动控制台后运行 /superagent，沿用现有逐步确认向导。
- SSH 首版仍为 Linux 执行宿主；安装包可在远端手工运行，不经插件偷偷安装软件。跨系统全新安装与历史状态迁移分开，原快照恢复限制保持不变。

## 安装预检与安全

预检平台/架构、Node 版本、SQLite 可用性、Git 版本、npm CLI 定位、完整性清单和目标路径。npm 优先定位当前 Node 配套的 npm-cli.js，支持 Unix/Homebrew/NVM、Windows 安装目录及显式绝对路径；始终以 Node 启动，不 shell:true。

安装 npm/注册 Pi 时使用最小环境，保留系统路径/临时目录、代理和 CA，去除 NODE_OPTIONS、NODE_PATH、模型/管理/SSH/云凭据及用户 npm 配置。固定公共 registry；错误输出安全阶段码，不反射任意 stderr。下载仍需要能访问 registry（可使用代理/CA）；安装包不是离线依赖镜像。

文件清单仅允许固定相对文件名，拒绝穿越、symlink、缺失/超预算/摘要不符。只注册新安装的专属 Pi profile，路径和参数保持字面值，含空格/中文的目录作为验收用例。

## 验收与发布门禁

- 新机器验收只消费发布目录，不借工作区/global npm 的依赖定位；统一包先在 Linux 生成，再供 Linux/macOS/Windows matrix 下载同一 artifact 安装。
- 真实 npm ci、Node SQLite、Pi 版本和插件注册/加载、bootstrap 定位、CLI init/start/request/shutdown、Web、SDK Node Job/会话基本流程。
- 空 HOME/独立 Pi profile、Windows Program Files 等 npm 候选路径、安装/项目目录带空格/中文、无 admin 权限的常规安装；秘密不进入回执/argv，未确认不写文件，失败不留下半可用入口。
- 单元测试不访问 registry；发行安装 smoke 单独运行，CI 发布门禁包含它。Linux 本地结果与 macOS/Windows CI/实机结果分别记录。
- 未发布 npm、没有产品远端 Git/CI 运行证据时，提供本地发布目录及 CI 定义，不宣称已在未运行的平台通过。

## 检查项

- [x] 检查包依赖、Pi 安装/环境文档、进程与平台接线；比较方案并确定范围。
- [x] TDD：包完整性、平台/Node/npm、确认/路径/失败、参数数组与环境隔离。
- [x] 发布目录构建及依赖锁；原生安装与匹配 Pi/CLI 入口。
- [x] 同一发布产物干净安装、真实插件加载和服务/SDK 生命周期。
- [x] 六目标 CI 定义、部署说明、内联审查及完整验证。

## 内联审查与回归

无独立 reviewer 工具，也无产品 Git SHA；按审查清单对安装器、构建器、真实消费者、CI 和文档逐项核对。

- 重新解析 lock 实际将 @isaacs/nonrecursive-glob-match 1.0.3 升到 1.1.0，漂移门禁首先拒绝；改为从工作区图生成/裁剪生产锁，已知镜像 URL 只规范化地址，保留版本和 integrity。
- 实际无可执行位的 JS CLI 暴露入口直接 spawn 脚本的问题，回归先红后绿，改为 process.execPath + argv，覆盖 Windows 不执行 shebang 的情况。
- 空 PATH 的 npm 候选补当前 Node 同目录的 npm 链接，兼容 Homebrew 等布局。
- 清除继承的 PI_CODING_AGENT_SESSION_DIR，先红后绿；绑定独立 profile，传参保持字面值。
- 模拟 SDK 加载失败但版本命令成功，原安装器错误宣布成功；新增真实 SDK 加载探针后拒绝并清理目标，不回显加载错误原文。
- 安装成功清理临时 npm 配置/cache，实际消费者回归先失败后通过。
- 在目标上层放合法 npm workspace，真实安装原先报 INSTALL_NPM_RUNTIME；加入明确 prefix 和 workspaces=false 后成功，且上层 package/lock/node_modules 不变。
- 插件显式声明 Node >=24，与服务及安装器一致；不增加插件生产依赖。
- Linux 真实消费者包含 SDK 加载的延迟 setup 模块、遮罩 Input、实例测试 key 保存与显式停止；未付费推理、真人 OAuth 或修改业务实例。安装输出实际 Node/CLI 路径，供 SSH 手工配置。
- 首次完整回归在 systemd 脚本的 35s 后重开遇到锁未过期；补充采样捕获约 2.5s 墙钟回拨。新增测试辅助 `stale-lock-grace.mjs`，最少等待 35s 并按真实锁龄补足窗口，以 90s 单调时钟截止；模拟 6s 回拨/冻结墙钟先红后绿。脚本不删锁、不改 mtime、不重试启动；生产锁的 30s 过期和 unit 的 35s 重启参数不变。

## 最终本地证据

2026-11-06：57 文件/464 测试、类型/构建、SDK 直连/代理/多仓库、控制桥、托管 launcher、CLI 备份、tarball、Chromium、真实 OpenSSH、20 轮七套件稳定性全部通过。工作区、两类 tarball 消费者及统一安装 runtime/client 共五项生产审计均为 0。脚本语法、六目标 CI YAML、core/upstream 无改动检查通过。未运行的 OS/架构仍待 CI/实机验收。

- 成功全量：`/tmp/pi-superagent-portable-verified.log`
- 首次失败（保留）：`/tmp/pi-superagent-portable-final.log`
- 时钟观测：`/tmp/sa-systemd-lock-timing.log`、`/tmp/sa-systemd-lock-verified.log`
- 稳定性：`.artifacts/stability-1793934466255-1371934/`
- 发布目录：`.artifacts/portable-release/`
- ZIP：`.artifacts/pi-superagent-0.1.0-alpha.1-portable.zip`，302196 bytes；SHA-256 `d12930755dee41b85e34a7c39663fd7776ed18263d635689ed0729333f76ac45`。
- ZIP 解压后再次运行实际安装/SDK 向导/CLI 生命周期通过，日志 `/tmp/sa-portable-zip.log`。


