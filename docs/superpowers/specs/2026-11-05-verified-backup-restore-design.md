# 校验型离线备份与原路径恢复

## 范围与选择

继续运维主线。本轮交付 CLI 离线备份、校验、同机原路径恢复及显式保留清理；升级使用备份/兼容性预检/人工重启流程。跨机或改路径迁移后续单独实现：SQLite 的 execution/session 指针和 Git worktree 管理区含绝对路径，直接改 config.repository 不能完成迁移。

已比较三个方案：原有 cp 无清单与恢复预检；全量镜像源仓库会扩大数据/写入范围；采用实例快照与外部 Git 依赖校验，先提供可验证、失败关闭的恢复。备份保留实例文件及未提交工作文件，不复制外部仓库 Git 对象库。Git 源仓库和 worktree 管理区由仓库备份保护；恢复要求相关管理区/任务分支仍与快照一致，否则拒绝而不是重置共享仓库。

沿用用户决定：设计写入文档后直接实现，不另拆实施计划、不再次审批。无产品 Git 仓库，不借 upstream 提交；仅临时数据和本地模型测试，不备份/删除业务数据。

## 命令与默认安全性

- `backup DEST --state-dir ORIGIN`：兼容现有命令；目标必须不存在且在实例和仓库外，创建私有目录和完整清单。包含凭据，输出只含元数据。
- `backup-check BACKUP`：校验格式、全部路径/大小/摘要/类型、SQLite 完整性与 schema、身份及外部 Git 依赖；不启动服务或执行模型。
- `restore BACKUP --state-dir ORIGINAL --expected-instance-id UUID [--yes]`：无 yes 为预检；明确确认后恢复到**不存在的原路径**，不覆盖、不自动搬走旧数据。保留 ID、管理认证、模型凭据、SQLite revision/暂停和任务状态；不启动、不恢复 systemd 登记。
- `backup-prune ROOT --state-dir ORIGINAL --expected-instance-id UUID --keep N [--yes]`：只处理 ROOT 直接子目录中完整校验且属于此实例/原路径的快照。默认仅预览；yes 后删除超出 N 个的新旧排序保留量。至少保留 1 个；不清理任务、会话、worktree、原仓库或未知/损坏/未完成目录。
- 不新增模型工具、公开 HTTP 恢复端点或自动定时删除；首版运维在执行主机 CLI 运行，远端同样使用远端 CLI。

## 快照格式与读写边界

清单 `.pi-superagent-backup.json` format1，记录 backup UUID、时间、产品/平台、主机/UID/OS 账户及个人目录、原路径/实例 ID、配置/数据库 schema、文件清单（普通文件 SHA256/大小/执行位/修改时间、目录、symlink 的链接文本），以及外部 Git 依赖。清单自身的规范化 JSON 带 SHA256 校验和；恢复以清单时间戳为准，快照传输改变文件 mtime 不影响 SDK 最近会话选择。数据仍直接放在备份根，兼容现有 admin.token 路径；旧 cp 备份无清单，不自动解释为可恢复快照。

- 文件复制/摘要采用异步 I/O，避免大文件阻断实例锁心跳；有文件数、深度、清单大小及总字节预算。
- symlink 只保存链接文本，不解引用；关键配置/凭据/数据库及其 sidecar 必须为普通文件，agent/sessions/work 根必须为目录。清单拒绝绝对/穿越路径、重复项、子项落在 symlink 下、未知额外文件、特殊设备/管道。备份验收拒绝 hardlink，目标文件独立复制。
- 目标目录 0700，普通文件 0600（可执行文件 0700）。不把秘密写到 argv、日志或清单摘要输出。
- SQLite 在**目标副本**中恢复 WAL、checkpoint 成独立数据库，保留业务内容。完整性/schema 校验在固定 Worker 线程执行，使父进程的锁心跳持续；不对源数据库做迁移/checkpoint。超时请求终止并等待线程退出后才清理文件/释放锁，原生 I/O 阻塞可能延长等待。缺少数据库的新实例可备份，未知 schema 拒绝。
- 备份前后比较源文件及外部 Git 指纹，检测并发变化；仓库操作须静止。独立备份父目录锁避免本产品创建/清理/恢复相互竞争。

## 停机、托管及发布

备份持有 supervision 控制锁、实例锁，并绑定 API 端口检查离线。已登记 systemd 的实例须 inactive/failed 且 disabled；不替用户停止、disable 或删除锁。恢复前应卸载原 systemd 登记，恢复不复制 supervision.json；服务启动和重新注册由用户分别确认。

创建目标先排他 mkdir，写入 in-progress 标记；配置读取和初始化拒绝备份及未完成恢复目录，防止直接把备份启动成第二实例。完整校验后才移除进行中标记。失败清理仅限本次新建目标；进程中断遗留标记的目录不能运行，不自动覆盖修复。

恢复保持原主机、UID、OS 账户及个人目录、原目录、平台和实例身份；目标必须不存在，现有数据由管理员先妥善保留。锁/端口/托管 unit 不明确时拒绝。不更换 Token、不自动 resume、不调用外部渠道；旧快照可能早于已发送的外部消息，管理员恢复后需先核对渠道再启动。

## Git 依赖

记录配置各成员的 source/commonDir；对 work 下每个真实 .git 文件识别其源仓库、专属 worktrees 管理目录、任务分支和 HEAD，并记录管理目录文件摘要。要求反向 gitdir 指针指向原执行路径、分支为该 Ticket 的 pi-superagent 分支、无 Git 锁或 symlink 管理路径。源 checkout/common-dir 必须独立于实例目录。只读 Git 命令，不创建、reset、fetch、repair、prune 或覆盖共享 refs/index；repositoryGit 固定 GIT_NO_LAZY_FETCH=1，禁止 partial clone 在对象检查时隐式取回对象。

校验/恢复检查这些外部依赖仍存在且一致。清理旧备份只校验快照自身，不要求历史 Git 依赖仍相同。跨机器、原仓库丢失或任务 Git 管理区已演进时，本轮拒绝自动恢复；后续迁移需额外设计 Git 对象/管理区和路径映射的一致性协议。

## 内联审查修正

本轮没有独立 reviewer 工具，按请求审查清单在当前会话审查，重要问题通过先红后绿回归修复：

- 拒绝位于实例目录内、随实例丢失而无法独立预检的源 checkout/common-dir。
- 清理操作拒绝实例/源仓库内部 ROOT，以及包含受保护路径的候选目录。
- 创建与读取快照统一校验关键目录、凭据和 SQLite sidecar 类型，拒绝重建清单后的关键 symlink。
- 真实 partial clone 复现 cat-file 隐式取对象，宿主 Git 固定禁止 lazy fetch。
- 真实 SDK 复现复制后选中旧会话；记录并恢复文件 mtime，清单摘要覆盖时间戳等元数据。
- 数据库 Worker 超时等到退出再让调用者清理/释放锁。
- 除 UID 外记录 OS 用户名及个人目录，覆盖没有数字 UID 的平台；Windows ACL/实机仍需部署验收。

## 验证清单

- [x] 阅读实例、SQLite、worktree、CLI 与托管实现；明确恢复范围和迁移约束。
- [x] TDD：完整快照/数据库/秘密、破坏/路径/链接、在线与托管拒绝、确认/不覆盖、恢复身份/暂停/会话/工作文件、Git 漂移拒绝。
- [x] TDD：保留清理预览、至少留一份、仅匹配且完整的快照、未知目录/损坏/软链接不删。
- [x] CLI 接线、真实临时实例恢复与 tarball 验证、部署/升级文档。
- [x] 完整 verify/Web/OpenSSH/security/stability、core/upstream 不变检查及内联审查。

## 最终验证（2026-11-06）

- `npm run verify && npm run test:web && npm run test:ssh && npm run test:security && npm run test:stability -- 20` 全部通过：55 文件、453 测试，含 22 项备份回归。
- TypeScript、两包构建、实际 SDK 直连/代理/多仓库执行、stdio 桥、unit/launcher 恢复、CLI 备份恢复、真实 tarball 消费者、Chromium 及 OpenSSH 容器通过。
- 工作区、插件独立安装、服务+插件安装生产审计均为 0；20 轮稳定性无失败、无自动重试。日志 `/tmp/pi-superagent-backup-final.log`，逐轮 `.artifacts/stability-1793927888279-1332900/`。
- JS 脚本语法、`diff -qr upstream/src/core packages/server/src/core` 及 upstream 工作区/索引无修改检查通过；测试 SSH 容器已清理。
- Linux 实测；macOS/Windows 实机与 ACL、真实 systemd manager/开机仍待验收。跨机/改路径/schema 迁移及业务数据清理未实现。本轮没有业务数据备份/恢复、宿主系统注册或 npm 发布。
