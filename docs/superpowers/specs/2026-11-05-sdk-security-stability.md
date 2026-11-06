# Pi SDK 1.5 安全升级与稳定性

## 目标与范围

延续用户“继续”及既定顺序：先完成 SDK 安全升级和稳定性验证，再处理系统托管、备份恢复。设计记录后直接实施，不另拆计划。本轮不发布 npm、不注册系统服务、不重启业务实例，也不调用付费模型或真人 OAuth。

升级前：服务固定 SDK 1.4.0，插件 SDK/TUI dev 为 1.4.0，optional peer 为 ^1.4.0；公开 registry 生产审计报告 3 个受影响包（2 moderate、1 high），涉及 minimatch 10.2.6、undici 8.10.2。基线 49 文件 / 399 测试通过。

## 方案选择

1. **采用上游 SDK 1.5.0**：minimatch 11.0.3、undici 8.12.3；协调插件 SDK/TUI dev 到 1.5.0，optional peer 下限提高至 ^1.5.0。使用上游发布包，不维护 fork。
2. 不采用 root overrides：消费者安装 tarball 时不会继承工作区覆盖，无法保证发布依赖树。
3. 不单独替换 SDK 内部 HTTP 库或扩大认证适配：保留实例凭据、固定子进程、代理初始化、投递磁盘确认及现有授权边界。

产品 Node 下限仍为 24，两包仍是未发布的 0.1.0-alpha.1；协议 1、SQLite schema 1、核心领域代码不变。插件继续使用宿主 UI，不声明生产 SDK/TUI dependencies，不安装第二份 SDK。更新宿主 Pi 至 1.5+ 后 reload；运行服务需要用户显式重启才加载新 SDK，SSH 远端须更新同版包。

## 兼容性检查

核对 npm 1.5.0 实际 tarball 与 1.4.0：createAgentSession、ModelRuntime、SessionManager.continueRecent、ResourceLoader 契约继续可用；SDK 新增流函数认证标记和上下文投影 helper，无需修改现有调用。1.5 的 breaking change 是工具参数改用 pi-schema，TypeBox 的非 JSON Schema 扩展不再适用；本项目工具只使用标准 JSON Schema，已补真实 SDK validator 对枚举、必填字段、上下界、嵌套报告和转换副本的兼容测试，宿主 Zod 授权/数据检查继续保留。Session JSONL 仍为 v3；投递确认继续读取 user/custom_message 原始持久记录，不依赖模型上下文投影。认证、代理和资源隔离由实际子进程集成测试验证。

## 验证与审计

- 增加依赖契约回归，先证明旧 pins/lock 不满足修复版本，再升级 manifest/lock。
- 审计项目生产树和两个 tarball 干净安装后的实际生产树；另检验单独安装插件不带 SDK/TUI。
- 把生产审计作为显式 test:security 和 CI 门禁；registry 错误或安全发现不吞掉。普通离线单元测试不访问 registry。
- 运行类型、单元、构建、真实 SDK 直连/代理、多仓库、远端控制桥、安装包、Chromium、真实 OpenSSH 容器。
- 对 coordination/driver 重复运行并保留失败诊断；历史 background notice 偶发失败只有在获得根因和确定性回归后才记为修复。重复通过只作为稳定性观察，不改生产截止或加自动重试掩盖失败。
- 生产审计零发现以运行时间和依赖树为准；未来 advisory 由 CI 持续检查。Linux 证据不替代其他平台 CI 或真人云端验收。

## 检查项

- [x] 升级前 audit 与 399 项基线；tarball / API 核对。
- [x] 依赖契约红绿与协调 pins/lock 升级。
- [x] 项目与消费者生产依赖审计、插件独立安装边界。
- [x] 稳定性重复与失败诊断。
- [x] 完整集成与 core/upstream 不变检查。
- [x] 更新 SECURITY、README、设计状态及证据。

## 失败调查与修正

全量并行测试先出现 coordination 的重启 relay 断言失败，随后重复全量第 7 轮出现 remote init `PORT_BUSY`，不是把之前 NACK fork 截止问题再次归因。

针对协调通知建立独立循环和逐阶段快照，迭代 882 捕获 wall clock 回拨：`Date.now()` 从 1793844081105 变为 1793844079839，而 `performance.now()` 从 115353.668 增到 115366.185。relay 已保存，due=1793844081111；重开后的 now=1793844079868，小于 due，因此一次 tick 不投递。原始证据 `/tmp/sa-coordination-failure.json`。没有丢数据或 SDK 投递失败。

coordination 套件现在只替换 Date 为受控时钟，不替换真实 timers 或数据库；补两条确定性回拨回归，覆盖 follow_up（含重开数据库）和 ticket_ended：未到期保留原 Effect，到期仅投递一次，背景通知 wake=false。生产调度仍按持久 wall-clock due 等待；时钟大幅回拨会相应延迟排期工作。本轮捕获了这一类失败的原因；早期 background notice 单次失败没有原始时钟记录。

远端 fixture 原先释放 listen(0) 获得的端口后，异步检查 Git，再探测同端口；其间端口可能被其他连接重新分配。本机临时端口范围实测为 44620..48715。测试服务端口现从 20000..29999 探测，避开并行临时连接池；没有重试失败的产品操作，也没有放宽产品端口占用拒绝。另补真实持有端口时 init 返回 PORT_BUSY、无私有目录写入、原 listener 仍在线的回归。

## 最终证据（2026-11-05）

- 51 个 Vitest 文件、406 项通过；依赖约束测试在 1.4.0 下两项失败，升级后通过。
- `npm run verify && npm run test:web && npm run test:ssh && npm run test:security && npm run test:stability -- 20` 完整通过，日志 `/tmp/pi-superagent-sdk15-final.log`。
- 项目、插件单独 tarball、服务+插件 tarballs：公开 registry 生产审计均为 0；消费者实际树 SDK/TUI 1.5.0、minimatch 11.0.3、undici 8.12.3；插件独立安装只有自身包。
- 真实 SDK 直连/代理、多仓库执行/恢复、控制桥/测试认证、安装包、Chromium 和临时 OpenSSH 容器均通过；最后 20 轮 coordination/driver/remote-control 全通过，不重试失败轮次。
- 新 test:security、test:stability 已接入三平台 CI 定义，日志上传保留 7 天；目前执行证据仍为本地 Linux，没有产品远端 CI 记录。
- 脚本语法、core 内容一致、upstream 工作树/暂存区干净；测试 SSH 容器已清理。本会话内联审查，无独立 reviewer。
- 未修改生产 TypeScript 执行逻辑或领域 core，没有操作真实业务实例、系统服务、付费模型或 npm 发布。用户更新依赖和显式重启后才会加载新版 SDK。

