# 本地优先的管理模式

用户决定先跑通单用户本机工作流，保留以后部署共享机器的可能性。Web 登录不能成为重启的前置条件；本地管理不依赖 GitHub PAT、OpenAI 登录或管理员 Token。

## 调查与取舍

既有实例日志记录新进程已监听配置端口；匿名 /health 返回 200，绑定与磁盘 instanceId/repository 一致，匿名管理请求返回 401。CLI 启动阶段成功而插件后验失败，旧实现吞掉具体错误，尚不足以确定当时是连接、HTTP 状态还是实例核验失败。此次增加分阶段安全诊断，不把改成免登录当作对旧错误原因的证明。

选择显式 local/token 双模式，而非删除认证代码。访问模式单独保存到私有 `management.json`，不混入 SQLite 业务配置、Mandate 或 GitHub 来源。

- 新实例默认 local，不生成、不读取 admin.token。旧实例缺少 management.json 时保留 token 行为，避免静默改变其他实例。
- local 信任本机进程，只监听 127.0.0.1。保留 Host、严格 Origin、CSP；写请求需要 JSON 类型和固定的自定义本地客户端头，阻断跨站表单/简单请求。它不是共享用户隔离；共享部署可显式选择 token 模式，继续保留 Bearer、cookie/CSRF、一次性登录授权。
- 访问模式仅可在服务停止后通过本机 CLI 修改，用实例锁和 expected instanceId 校验，并原子写文件。保留已有 Token 以便切回；需要 token 模式但文件缺失时生成实例专属凭据。模式不经业务配置 API 修改。

## 客户端及迁移

1. 本地 Web 直接进入工作区，不显示登录框/退出登录；插件 `/superagent web` 打开普通 URL，不发放登录 code。CLI、插件、本地 restart 不要求 Token 文件存在。
2. `/superagent local`（菜单“切换到本地模式”）用于已有实例：展示信任范围及目标并确认，预检新 CLI，旧服务可达时使用其已有连接完成退出（无需浏览器登录），等待锁/端口释放，再离线改为 local、启动、检查实例。已停止实例可直接切换并启动。不强杀未知进程或删除锁。
3. `/superagent restart` 保留当前模式。启动、停止与身份验证走本机管理 API，不依赖 Web session、模型认证或 GitHub。模型工具不能触发重启或切换模式。
4. 插件和 CLI loopback 客户端使用独立 Node HTTP 请求（禁用共享连接池），不受 Pi 宿主的模型 fetch/代理 dispatcher 或重启前连接影响；只允许本机 HTTP、拒绝跳转、限制响应和超时。异常区分连接代码、HTTP 状态、协议及身份，不回显凭据/响应正文。
5. 旧实例切换显式触发，不修改用户业务实例；本轮对临时实例验证全过程。模型 OAuth/API key 和可选 GitHub PAT 仍各管其自身用途。

## 验证

- [x] 模式读写：新实例 local、旧实例 token、缺少 Token 的本地启动、锁/身份保护、离线切换和凭据保留。
- [x] API：local 无认证读写及 restart；跨站/错误 Host/简单写请求拒绝；token 原有认证/CSRF 完整保留。
- [x] 客户端/插件：宿主 fetch 故障隔离、本地不读 Token、普通 URL、模式切换与重启命令、阶段诊断。
- [x] Chromium 和干净安装：local 直接进入、提交暂停任务、重启、数据保留；从 token 实例切到 local 后删除测试 Token 仍可再次重启和打开 Web。
- [x] 完整 verify/Web、语法与 core/upstream 无差异检查；文档同步。

2026-11-04：39 文件 / 352 测试、TypeScript、构建、SDK 直连/代理/多仓库、安装包、Chromium 与全部语法检查通过。安装包 CLI 在 NODE_USE_ENV_PROXY=1、失效代理且空 NO_PROXY 下仍可管理本机实例；插件宿主 fetch 被置为失败时仍可重启。补充离线旧实例缺少 Token 的转换覆盖。

内联自查补齐两处迁移体验：跨站 API 继续拒绝，但静态页可由外部链接导航打开；旧 token-mode 登录 fragment 在本地实例上清理后正常进入，不再返回令牌登录框。两处均先观察回归失败再修复。无独立 reviewer 工具；没有修改/重启用户真实实例。
