# 备份、恢复、升级与保留

当前 CLI 提供**校验型离线实例快照、同机/同账户/原路径恢复和显式备份保留清理**。跨机、改路径迁移及在线备份尚未实现。所有命令在执行主机运行；SSH 实例使用远端 CLI，不把凭据和快照下载到 Pi 聊天。

## 备份前准备

建议先暂停派单，等待在途工作到达可恢复点，再停止服务。快照保存实际暂停状态，恢复不会擅自改变它；原快照未暂停时，之后明确启动会按原配置继续工作。

```sh
pi-superagent pause --state-dir /absolute/instance
pi-superagent shutdown --state-dir /absolute/instance
# 已登记 systemd 的实例另行关闭自启；不会随 backup 自动修改：
pi-superagent service disable --yes --state-dir /absolute/instance
```

仅 systemd 实例需要第三行。备份要求实例锁、端口空闲；已登记 unit 必须 inactive/failed 且 disabled。实例、源仓库及任务工作目录在操作期间不得由其他程序修改。

在实例和仓库之外建立私有备份父目录，然后执行：

```sh
pi-superagent backup /private/backups/before-upgrade --state-dir /absolute/instance
pi-superagent backup-check /private/backups/before-upgrade
```

父目录须已存在，目标目录必须不存在。源 checkout 及 Git common-dir 必须位于实例目录之外，才能在原实例目录丢失后独立核验。可给 backup 加 `--expected-instance-id UUID`。备份包含管理 Token、模型 OAuth/API 凭据、渠道凭据、会话、SQLite 和工作文件；应使用加密磁盘或另外加密后再离机保存。产品不上传、不加密或打印凭据内容。

POSIX 目标目录为 0700、普通文件为 0600、可执行文件为 0700；校验拒绝可被组/其他用户访问的备份根目录，以及不属于当前账户的备份目录。Windows ACL 仍需部署检查，当前实测环境为 Linux。

## 快照包含什么

- 根 `.pi-superagent-backup.json`：格式版本、UUID、记录时间、原主机名/UID/账户及个人目录/平台/路径、实例 ID、文件类型/摘要/修改时间、数据库 schema/revision/暂停状态和 Git 依赖指纹；清单自身也有 SHA256 校验和。
- 原实例文件，保持 admin.token、agent、sessions、work 等相对位置；symlink 仅保留链接文本，不复制目标内容；关键目录、配置、凭据及 SQLite 文件拒绝链接。按清单恢复文件修改时间，保留 SDK 选择最近会话的顺序；传输时快照文件的 mtime 改变不会改写清单记录。
- SQLite 在目标副本中恢复 WAL，并转换为独立数据库；不修改源数据库。新建且尚无 SQLite 的实例也能备份。
- 不包含系统 unit 文件、npm 包、Node 运行时或外部源仓库 Git 对象库。supervision.json 可作为历史文件保存在快照中，恢复时不会装回。

工作目录内的 `.git` 文件通常指向源仓库的 **Git common-dir**。外部仓库备份需覆盖 common-dir 中的 worktrees 管理区、index 和未提交 blob；代码提交本身不保存全部这些状态。本功能记录并核对这些依赖，不执行 Git reset/fetch/repair 或覆盖共享 refs；宿主 Git 检查设置 GIT_NO_LAZY_FETCH=1，禁止 partial clone 按需自动获取对象。

`backup-check` 验证文件清单、SHA256、路径、SQLite 完整性/schema、源仓库身份、任务分支/HEAD及其管理区指纹。管理区有变化时返回 `BACKUP_GIT_CHANGED`，应核对对应仓库备份和执行状态。完整 Git 对象库的灾难恢复由仓库备份负责。

校验型备份使用格式 1；旧版 `backup` 生成的纯 cp 目录没有清单，不会自动当成可恢复快照。新备份不能直接作为实例 serve/init，避免误启动同身份副本。

## 恢复到原路径

1. 保留当前数据并停止全部相关进程。若原实例使用 systemd，在原目录仍可读取时先显式 `service uninstall --yes`；确认无该实例 unit 后，再将旧目录移到安全位置。
2. 确保原实例路径**不存在**，原源仓库和对应 Git 管理区仍完整且匹配快照。主机名、UID、OS 账户名/个人目录及平台必须一致；账户信息来自 OS，不使用终端 HOME 覆盖值。
3. 先预检，再确认恢复：

```sh
pi-superagent restore /private/backups/before-upgrade \
  --state-dir /absolute/instance --expected-instance-id UUID

pi-superagent restore /private/backups/before-upgrade \
  --state-dir /absolute/instance --expected-instance-id UUID --yes
```

无 `--yes` 只预检。恢复不覆盖任何现有目录，不改实例 ID、Token、模型凭据、设置 revision、任务或暂停状态，不启动服务、不注册自启。CLI 回执显示 `restored`、`started: false`、`supervision: not-restored`。

恢复会回到快照时刻。数据库以外已发生的代码发布、外部评论、部署和邮件不会随之回退；启动前核对渠道与任务进度。恢复前建议使用已经暂停的快照。旧凭据是否过期，需要随后正常认证/连接验证。

原路径、主机/UID、未知 schema、Git 管理区不一致或仍有 unit 时会拒绝，不猜测迁移映射。若原实例已丢失但 unit 仍存在，管理员须先核对并处理该 unit；恢复工具不会删除无法确认归属的系统配置。

### 中断与失败

创建/恢复目标先排他建立私有目录并写进行中标记，完成校验后才发布；初始化和 Runtime 拒绝读取未完成恢复。POSIX 同步文件及目录条目，Windows 目录 fsync 不可用。

普通失败只清理本次新建目标；进程被强制终止可能留下带 `.pi-superagent-backing-up` 或 `.pi-superagent-restoring` 的目录，不能启动。先保留并核对这些目录，不以删除标记的方式跳过校验；重新操作需要不存在的目标。锁使用正常过期处理，控制锁可能需要约 120 秒，不手工删锁。SQLite 检查在线程中运行，60 秒后请求终止，并等待线程真正退出才清理文件和释放锁；原生 I/O 阻塞时等待可能更长。

## 升级和回退

1. 记录包版本、实例 UUID、Node/CLI 路径和 `service status`；暂停、停机，托管实例先 disable。
2. 创建并校验备份；同步保存外部仓库完整 Git 状态。
3. 更新服务包及依赖，插件复用宿主 Pi；按版本要求更新宿主 Pi 并 `/reload`。
4. 保持路径时显式启动，检查状态、日志和模型，再分别确认派单、自启。改变 Node/CLI 路径时按 [systemd 指南](systemd.md)先卸载旧登记再注册。
5. 若需要回退，先停止新版本、保留其数据及日志；使用匹配的旧包和上述恢复流程。已经改变的外部 Git 状态必须另行核对，不能直接重置共享仓库。

当前只接受已知快照格式及 config/SQLite schema1，不做自动 schema 迁移或降级打开。跨机、改路径、Git 管理区重建会在后续迁移功能中单独处理。

## 备份保留清理

```sh
# 预览，仅针对此 UUID、原路径、主机和账户的完整快照
pi-superagent backup-prune /private/backups --keep 3 \
  --state-dir /absolute/instance --expected-instance-id UUID

# 确认按当前状态重新计算并清理
pi-superagent backup-prune /private/backups --keep 3 \
  --state-dir /absolute/instance --expected-instance-id UUID --yes
```

按清单记录时间排序，至少保留 1 份。只检查 ROOT 的直接子目录；未知、损坏、未完成、其他实例及 symlink 目录保留并计入 skipped。不允许在实例或源仓库内运行清理，也不删除其祖先目录。旧快照清理只校验快照本身，不要求其历史 Git 管理状态仍与现在一致；清理前另用 backup-check 确认准备保留的恢复点。

没有后台自动清理。当前保留策略只管理备份，不删除工单、会话、Job、日志、worktree 或 Git refs。

## 主要错误与验证

| 代码 | 处理 |
| --- | --- |
| BACKUP_BUSY / INSTANCE_BUSY | 停机、检查端口或其他维护操作，等待锁正常释放 |
| BACKUP_EXISTS / BACKUP_PATH | 使用不存在且符合原路径/范围要求的目标；父目录需存在 |
| BACKUP_FORMAT / BACKUP_INTEGRITY | 检查清单、文件摘要和传输；不恢复损坏或无清单目录 |
| BACKUP_PERMISSIONS / BACKUP_HOST / BACKUP_PLATFORM | 检查备份根权限、账户/个人目录、主机名和平台 |
| BACKUP_SCHEMA / BACKUP_DATABASE / BACKUP_DATABASE_TIMEOUT | 检查版本、SQLite 完整性和存储 I/O；使用匹配包和有效备份 |
| BACKUP_GIT_CHANGED | 核对源仓库、任务分支和 worktree 管理区的独立备份 |
| BACKUP_SUPERVISION | 备份前停机并 disable；恢复前卸载原登记 |
| BACKUP_INCOMPLETE / BACKUP_CHANGED | 保留诊断，排除并发写入，重新创建快照或恢复 |
| BACKUP_FILE_TYPE / BACKUP_LIMIT | 检查特殊文件/关键文件链接及预算 |
| BACKUP_TIMESTAMPS | 目标文件系统无法以要求精度保存文件修改时间，恢复已中止 |

自动测试包含真实 SDK 最近会话选择、清单时间戳损坏、partial clone 禁止自动取对象、数据库超时等待线程退出，以及 WAL 崩溃、摘要/格式破坏、穿越、硬/软链接、权限、确认、已有目标、在线/托管拒绝、初始化竞争、单库/嵌套多库工作文件、Git 漂移和清理范围。`npm run test:backup` 使用真实临时 CLI/API 验证快照和恢复后的请求幂等；已纳入 integration。没有对真实业务实例执行备份、恢复或删除。
