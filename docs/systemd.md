# Linux systemd 用户服务

Linux 本地实例和 SSH Linux 实例可以选择 systemd 用户托管。原来的 detached 模式继续保留，不会自动迁移；macOS launchd / Windows 原生托管尚未实现。

托管提供失败重启和登录自启；实例的模型、工单、授权和暂停状态仍由原有 SQLite / Runtime 管理。注册、启用自启、启动是三个独立动作。

## 前置条件

- Linux，systemd **245+**，Node 24+，同版服务包。
- 以专用服务账户运行；该用户的 systemd manager 和 `/run/user/UID/bus` 可用。
- 使用该 OS 用户标准 `~/.config/systemd/user/`；不读取自定义 bus 或 `SYSTEMD_UNIT_PATH`。
- 模型凭据放在实例 `agent/auth.json`，GitHub 可选凭据放在 `github.token`。托管进程不继承当前终端的模型/API/SSH 凭据或 NODE_OPTIONS。
- 先构建或安装新版两包；宿主 Pi 1.5+，执行 `/reload`。SSH 时同步更新远端服务包。

可在执行主机的终端检查：

```sh
systemctl --user --version
systemctl --user status
```

若 user manager 不可达，先检查该账户的登录会话和系统配置。插件不会 sudo、启用 linger 或注册 root 系统服务。

## 注册并启动

**注册前先停止实例**。CLI 示例（均在执行主机运行）：

```sh
pi-superagent shutdown --state-dir /absolute/instance
pi-superagent service plan --state-dir /absolute/instance
pi-superagent service install --yes --state-dir /absolute/instance
pi-superagent service enable --yes --state-dir /absolute/instance
pi-superagent start --state-dir /absolute/instance
pi-superagent service status --state-dir /absolute/instance
```

`plan` 只显示路径和 unit 文本。`install` 要求实例离线，仅注册，不启动、不启用自启。`enable` 仅启用后续登录自启；省略这一行时仍可手动启动并获得失败重启。所有 service 修改动作均需 `--yes`；可加 `--expected-instance-id UUID` 防止操作被替换的实例。

在绑定项目的 Pi 中：

```text
/superagent service
/superagent service plan
/superagent service install
/superagent service enable
/superagent restart
/superagent service status
```

菜单也提供“系统托管”。本地注册前用执行主机 CLI `shutdown` 停止；SSH 实例也可先 `/superagent shutdown`。每个修改动作单独确认。模型工具、会话加载和状态轮询不注册或启用服务；service 命令通过受限 SSH 控制桥管理远端，不需要 API 隧道在线。

已注册实例的 CLI `start` / `shutdown` 自动走 systemctl。Pi 重启经新版 CLI 停止，再等待实例锁与端口释放，随后由 systemd 启动，不另起 detached 进程。裸 `serve` 会拒绝已注册实例，避免误用。内部 `--supervised` 入口由生成的 unit 调用，不作为日常手动启动命令。

## 登录自启与开机运行

`enable` 配置的是用户服务登录自启。无登录时也需要开机运行，应由管理员另外评估并开启该账户的 **linger**；状态会显示 `linger: true / false / null`，null 表示未能确认。插件不自动执行此系统级变更。

如果管理员决定开启，可在服务器上自行使用 `loginctl enable-linger USER`（可能需要管理员授权）。应按该服务器的账户、资源和安全策略安排，使用专用账户。

## 崩溃恢复与停止

- `Restart=on-failure`：异常退出由 systemd 恢复，正常管理关闭不会被再次拉起。
- 重启间隔 **35 秒**，在墙钟正常推进时涵盖实例锁 30 秒过期判断；不删除锁或伪造修改时间。锁龄使用文件 mtime/墙钟，系统时间回拨可能延后恢复，使首次重启仍遇到有效锁；由后续 on-failure 周期再次尝试，仍受启动节流约束。
- 5 分钟最多 5 次启动；持续失败后检查 `service status` 和日志，再明确 `start`。
- `KillMode=control-group`，停止宽限 30 秒；systemd 在超时后清理本 unit 的子进程，不涉及其他服务。Worker 仍具有该 OS 账户权限，unit 不是应用沙箱。
- 恢复重开持久数据库、会话和任务工作目录，沿用已有中断 Assignment 处理；不改变暂停状态、不重新提交请求。

输出保存在 `INSTANCE/service.log`。`service status` 返回 unit 状态、是否启用、MainPID、自动重启次数和结果；MainPID 是托管 launcher。普通 API/Pi status 显示登记的托管类型，不在每次轮询调用 systemctl。

## 代理、CA 与工具 PATH

unit 使用 `/usr/bin/env -i` 和固定 Node/launcher 路径，不复制当前终端环境。可在实例下创建私有 `service.env.json`：

```json
{
  "PATH": "/opt/tools/bin:/usr/local/bin:/usr/bin:/bin",
  "HTTPS_PROXY": "http://127.0.0.1:10808",
  "NO_PROXY": "localhost,127.0.0.1,::1",
  "NODE_EXTRA_CA_CERTS": "/absolute/private-ca.pem"
}
```

POSIX 文件权限必须 `0600`，归当前账户，不能是 symlink。允许 PATH、locale、代理和 CA 设置；拒绝 NODE_OPTIONS、模型或渠道 Token 等未知键。launcher 在启动服务 Node **之前**设置环境，CA 能在 Node 启动时生效。配置值不进入 unit、argv、plan 或插件输出；代理 URL 若含凭据，应按秘密保存这个文件。修改后显式重启。

## 卸载、更新与部分失败

```sh
pi-superagent shutdown --state-dir /absolute/instance
pi-superagent service disable --yes --state-dir /absolute/instance
pi-superagent service uninstall --yes --state-dir /absolute/instance
```

`disable` 不停止当前服务。`uninstall` 要求实例离线，会禁用并移除匹配 unit，保留数据库、模型、凭据、会话及工作目录；之后 `start` 回到 detached 模式。

`supervision.json` 绑定实例 ID、规范目录、OS UID、Node/CLI 路径、unit 路径和内容摘要。unit 名为 `pi-superagent-UUID.service`。被编辑的 unit、symlink、drop-in、外来 FragmentPath 或实例路径变化会被拒绝，不会覆盖其他配置。不要手工编辑生成的 unit；代理/PATH 使用 `service.env.json`。

注册通过完整临时文件原子创建，不覆盖已有文件；daemon-reload 失败时保留声明，排障后可显式重复 install。卸载中断也保留声明以便继续核验。无归属或损坏的声明不会回退 detached，需先核对文件与实例身份。控制操作锁与运行锁独立。

Node/服务包保持同一路径时，更新文件和依赖后显式重启即可。要改 Node 或包路径，先停止、卸载旧托管，再从新 CLI 注册。升级前建议暂停、停机、disable，再创建校验型快照。原路径恢复前须卸载原登记，恢复工具不装回 supervision.json；完成数据核验后再分别注册、启动和启用自启。见 [备份/升级/回退指南](backup.md)。跨机或改路径迁移尚未实现，旧托管声明不能直接复用。

常见错误：

| 代码 | 检查项 |
| --- | --- |
| SERVICE_CONFIRM_REQUIRED | 修改命令需要明确 `--yes` 或 Pi 确认 |
| SERVICE_UNSUPPORTED / SERVICE_VERSION_UNSUPPORTED | Linux / systemd 245+ |
| SERVICE_MANAGER_UNAVAILABLE | 当前 OS 用户 manager、user bus、权限与系统配置 |
| INSTANCE_BUSY / SERVICE_RECOVERING | 仍在运行、锁/端口未释放，或 systemd 正在恢复 |
| SERVICE_CONTROL_BUSY | 另一个托管操作尚未结束；异常退出后等待控制锁过期 |
| SERVICE_IDENTITY / SERVICE_OWNERSHIP | 实例身份/路径、unit 原文、UID、drop-in 与 FragmentPath |
| SERVICE_ENV | 私有环境文件权限、所有者、格式和字段白名单 |

## 验证范围

自动测试覆盖身份、确认、锁/端口占用、环境隔离、unit 引用、旧 systemd 拒绝、部分注册恢复、所有权及插件/SSH 路由。`npm run test:supervision`（也纳入 integration）在 Linux 使用临时实例：systemd-analyze 验证 unit，实际 env-i launcher 启动、SIGKILL 服务进程、最少等待 35 秒并按实际墙钟锁龄补足宽限（90 秒单调截止，记录时钟跳变，不重试启动）、重开后核验请求/配置/暂停状态，随后正常关闭。未向宿主注册 unit。

这项冒烟由测试脚本触发第二次启动；真实 systemd 用户 manager 的自动拉起、linger 开机运行、服务器重启及完整云端任务仍需部署环境验收。
