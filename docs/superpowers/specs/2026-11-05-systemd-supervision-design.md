# Linux systemd 用户服务托管

## 范围与选择

按既定顺序继续系统托管、自启和崩溃恢复，先交付本地 Linux / SSH Linux 执行宿主。客户端仍保留跨平台目标；macOS launchd 和 Windows 原生托管后续分别实现。本轮不注册真实用户服务、不改 linger、不 sudo、不操作业务实例。

比较：仅提供手写 unit 缺少身份与生命周期衔接；自行写常驻 watchdog 会再造系统服务管理；采用 systemd --user，复用 cgroup 清理、退出状态、重启节流和登录启动。保留原 detached 模式，既有实例不自动迁移。

## 所有权与命令

- 服务包增加 `service plan|status|install|enable|disable|uninstall`；修改动作需要显式 `--yes`。plan/status 不写文件、不启服务。
- `/superagent service` 提供本地/SSH 的同一管理入口；仅交互式用户、明确绑定、核对 instanceId 后操作。加载、模型工具和普通状态轮询不注册服务。
- install 要求实例离线，仅注册 unit，不启动、不启用自启。enable 只设置自启，不顺带启动；disable 不停止当前服务。uninstall 要求实例离线，只移除本产品匹配的 unit，保留实例及数据。
- unit 名由实例 UUID 唯一生成；实例私有 `supervision.json` 绑定规范 stateDir、实例 ID、OS UID、Node/CLI 和 unit 路径及内容摘要。拒绝身份改变、路径搬移、symlink unit、被编辑/替换的 unit 和 drop-in。不覆盖无归属的现有 unit。
- 注册中断保留可识别的声明，后续 install/uninstall 可继续核对处理；不因部分失败回退 detached。独立控制锁串行化注册与生命周期，运行锁继续保护数据库。
- 安装后 CLI start/shutdown 走 systemctl；裸 serve 拒绝误启动第二个 detached 实例。Pi 重启及 SSH 生命周期停止经服务 CLI，以取消 systemd 待恢复状态；身份/锁/端口不确定仍拒绝启动。

## Unit 与环境

- Linux systemd 245+；Type=simple、前台 launcher → serve，launcher 将服务异常退出传为非零状态；Restart=on-failure，RestartSec=35s，给实例锁 30 秒 stale 和子进程退出留余量；5 分钟最多 5 次启动，失败节流后需要用户排障再启动。
- 正常 shutdown 返回成功退出，不被自动拉起；systemctl stop 取消自动恢复。KillMode=control-group，30 秒停止截止后由 systemd 清理本 unit 的进程组，不操作其他服务。
- UMask=0077、无提权、无额外沙箱承诺。stdout/stderr 使用实例 service.log；unit 不包含模型、管理、GitHub 或代理凭据。
- ExecStart 使用固定 /usr/bin/env -i 与绝对 Node/launcher，随后启动固定 CLI，避免继承用户 manager 的 NODE_OPTIONS、代理或凭据。路径按 systemd 规则引用，禁控制字符，转义 %，关闭 $ 展开，不使用 shell。
- 可选私有 `service.env.json` 只允许 PATH、locale、代理和 CA 字段；由 launcher 在服务 Node 启动前读取（包含 Node 启动期 CA 配置），拒绝未知键，不在命令输出/plan/unit 中显示值。模型与渠道凭据使用实例文件。
- systemctl 使用当前 OS 用户的标准 ~/.config/systemd/user 和 /run/user/UID/bus，不继承外部 bus、unit search path 或环境注入。首版不支持自定义 systemd 用户配置根。
- 用户服务 enable 默认登录时启动；要在无登录时开机运行，需要管理员另行开启 linger。状态提示此区别，不自动运行 loginctl enable-linger。

## 恢复与安全边界

现有 SQLite/Effects/Assignment 恢复保持不变，暂停状态不改变。服务崩溃后由 systemd 重启进程，Runtime 重开持久状态并沿用未完成工作恢复机制。崩溃不是业务重试命令，不自动重发请求或生成新派单。

管理状态显示 unit 登记、ActiveState、自启、重启次数及 linger；模型和派单就绪沿用现有 readiness。升级沿用同一 Node/CLI 路径时更新包后显式重启；路径变化先停止/卸载旧托管再重新注册。未知所有权拒绝自动修复。

## 验证与检查项

- [x] 阅读现有 CLI/插件/SSH 生命周期，比较方案，记录设计。
- [x] TDD：unit 引用/秘密、注册取消/身份/冲突/部分失败、仅用户操作、托管生命周期。
- [x] 实现独立 supervision 模块、CLI/SSH/插件接线与状态。
- [x] 临时实例崩溃恢复测试、systemd-analyze unit 校验、安装包入口验证。
- [x] 完整类型/单元/SDK/Web/SSH/生产审计及 core/upstream 不变检查。
- [x] 更新部署文档及证据：[systemd 指南](../../systemd.md)。未向真实用户 manager 注册服务。
- [ ] 实际 user manager 自动拉起、linger 开机运行和服务器重启验收；本轮测试脚本驱动重启，未进行这些外部部署操作。

本轮继续使用现有工作区（产品根无 Git），内联审查；不另拆实施计划、不重复审批。

## 实现与证据（2026-11-05）

- 新增 server `supervision-config.ts` / `supervision.ts` / `supervised-child.ts`，插件 `service-ui.ts`，部署指南及 `scripts/systemd-smoke.mjs`。
- CLI/插件预检后通过固定 CLI 停止，start/stop 绑定 expectedInstanceId；远端只允许固定 service actions。所有权/部分注册/旧版本/环境、UI 取消及模型工具拒绝均有回归。
- 内联审查改进：完整临时文件 fsync 后排他发布，不覆盖已有 unit；私有环境在服务 Node 启动前注入；部分注册允许核验后 daemon-reload；systemctl 跟随 SSH AbortSignal，取消后不继续后续步骤，保留声明供人工重试。后者先捕获“取消仍完成卸载”的失败，再修正通过。
- `npm run verify && npm run test:web && npm run test:ssh && npm run test:security && npm run test:stability -- 20` 通过：**54 文件、429 测试**，类型/构建、真实 SDK/代理/多库、远端桥、tarball、Chromium、OpenSSH 容器、20 轮定向稳定性。stability 现在同时覆盖 supervision。
- unit 由实际 systemd-analyze 验证；临时 launcher 实际 SIGKILL、异常退出、35 秒后重新启动保留请求/设置/暂停，正常退出释放锁。未把测试脚本重启算成 manager 自动拉起证据。
- 工作区、插件独立 tarball 和服务+插件安装的生产审计均 0。脚本语法、core/upstream 不变检查通过，SSH 容器清理完成。完整日志 `/tmp/pi-superagent-systemd-final.log`；重复日志 `.artifacts/stability-1793850748737-1272327/`。
- 包版本仍 0.1.0-alpha.1，SDK 1.5.0，API protocol1/SQLite schema1/core 不变。无独立 reviewer；未注册/启用系统服务、修改 linger、操作业务实例、连接真实云主机、调用付费模型或发布 npm。
- 下一项：备份恢复、升级/迁移和保留策略；真实系统托管及多平台验收继续保留。
