# 登录交互与 Web 地址恢复

后续 Web 登录体验由 [一键 Web 登录规范](2026-11-04-web-login-experience.md) 扩展：`/superagent web` 现在打开并登录，`/superagent web url` 保留本规范的只查看地址行为。

用户报告 OpenAI OAuth 未自动打开浏览器，手动登录后向导提示取消；随后找不到 Web URL。沿用文档化后直接实现的要求，不新增审批/实施计划。

## 调查事实

- 用户实例已存在，匿名 health 返回成功。没有读取认证令牌内容，也没有改动实例。
- 插件 `loginUI.notify` 仅显示 `auth_url`，没有浏览器打开操作。用户引用的英文提示来自 SDK 的 OpenAI Codex OAuth 流程。
- SDK 浏览器回调与 manual_code 输入并行；回调完成会中止该输入框，然后继续交换/保存凭据。RPC 已忽略该信号下的正常 resolve，但 reject 分支仍把它当作整场取消。
- 用户报告的长取消提示来自输入返回 undefined；当前缺少进一步原因记录，不能据此认定其浏览器回调已经成功。原输入框一次 Esc 就取消，其他 UI 异常也统一标为取消。
- Web 地址只在向导确认/成功文本出现，认证中断后缺少固定入口。
- 另核对 SDK 发现 `openai` 的直接订阅认证需要稳定 UUID 设备标识，向导未传该参数；使用既有 config.instanceId 提供 getDeviceId，不生成或复制个人身份文件。

## 修正

选择保留固定 SDK OAuth、修正宿主交互，不复刻 OAuth，不让前台接管或复制个人凭据。

1. 仅在用户显式登录时处理 SDK auth_url/device_code：用平台原生 opener 和参数数组尝试打开 HTTP(S) 登录页，不运行 shell。拒绝其他 scheme/带用户名密码的 URL。失败保留可复制链接，不重试认证请求。单次登录相同 URL 只打开一次。
2. 登录链接、设备码/等待进度显示在临时 widget，登录结束清理。manual_code 明确提示等待自动回调，空 Enter 不提交空代码，Esc 先确认取消；回调 URL 仍遮罩且仅通过 IPC 提交。SDK signal 关闭输入框不等于主动取消。
3. RPC 忽略被 SDK abort 的输入 Promise 的 resolve/reject；真正用户取消仍终止认证子进程。非取消 UI 异常给出独立错误，不回显异常里的秘密。成功、失败、取消和超时统一清理临时登录 UI。
4. OpenAI 订阅认证传入实例稳定身份 getDeviceId；OAuth 交互和凭据存储仍由固定 SDK 负责。
5. 连接 widget/状态保留 Web URL；实例创建后、进入认证前就显示，取消不丢失。`/superagent web` 和菜单可查看地址，离线也不启动服务；状态响应附加实际客户端 endpoint。地址不携带管理令牌。

## 验证

先红后绿覆盖 opener 参数/失败/不安全 scheme、真实 Input 的遮罩/空输入/确认取消/SDK abort、RPC 自动关闭输入时的 reject、主动取消、超时/崩溃、异常脱敏，以及初始化中断和会话重载后 URL 可见。安装包 smoke 继续验证真实 SDK API-key IPC，并验证新增地址入口。

不替用户发起 OAuth、模型探测或业务任务，不停止/重启其既有实例，不读取用户实例 auth.json/admin.token 的内容。真人浏览器登录留给用户在更新插件后重试；自动测试证据单独记录。

2026-11-04：31 个测试文件、309 项测试及完整 verify/Web/安装包检查通过。新增用例先红后绿。代理冒烟的 quiet fixture 首次出现过一次超时；增加失败时的 Trigger/Decision/脚本调用诊断后未复现，单独复跑及最后全量运行通过，未修改调度逻辑。测试未执行用户 OAuth 或付费模型请求。
