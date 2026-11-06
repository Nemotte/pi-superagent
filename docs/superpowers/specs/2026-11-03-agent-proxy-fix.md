# Pi SDK 子进程代理初始化修正

## 现象与证据

真实 GitHub Issue 已接收，Router 对 OpenAI 的请求连续连接超时。服务和子进程均继承 HTTP_PROXY/HTTPS_PROXY。

无认证 GET 探测的对照：默认 Node fetch 连接超时；NODE_USE_ENV_PROXY=1 后返回预期的 401；导入 Pi SDK 后又超时；SDK 导入完成后调用 Node 的 http.setGlobalProxyFromEnv() 则恢复 401。SDK 引入的 Undici 改变了全局 dispatcher，SDK 模式没有执行 Pi CLI 的代理初始化。

## 修正

只修正 Agent 子进程的网络装配：完成 SDK 导入后、创建 ModelRuntime 前，根据现有 HTTP_PROXY/HTTPS_PROXY（及小写形式）重新初始化 Node 环境代理。继续遵守 NO_PROXY；未配置代理时不改变网络。NODE_USE_ENV_PROXY=0 表示显式禁用。

采用 Node 公共 API，不导入 Pi 未公开的内部模块，不新增或覆盖 SDK 的 Undici 依赖。带代理运行需要 Node 提供 http.setGlobalProxyFromEnv，已验证版本为 24.14.1；缺少该 API 时给出启动错误。

仅设置进程启动变量的方案已由上述对照证实不足；直接依赖 SDK 私有 dispatcher 或另装 Undici 会增加版本耦合，因此不采用。

## 验证与恢复

给真实 Pi SDK 离线集成增加代理模式：模型使用不可解析的 model.invalid 域名，只能由本地 HTTP 代理转发到脚本模型。确认 Router 和 Worker 都经代理完成请求，GitHub/API loopback 由 NO_PROXY 排除；另保留无代理模式。所有测试只使用本地端点。

真实实例保持暂停直至回归通过。将旧评估标记为 unavailable，保留原 Trigger，重启后重新评估同一 Issue，不要求用户重复发帖。不改上游领域内核，不发布测试之外的内容。

## 回归结果与额外发现

代理回归先失败、补初始化后通过；直连模式也通过。浏览器回归暴露配置加载与输入竞争：进入配置页后请求尚未完成时可输入，返回值会覆盖草稿。已用延迟响应测试稳定重现，加载期间禁用表单并忽略过期响应后通过。

真实网络恢复后，订阅接口明确拒绝 gpt-5.5。认证模型列表返回 gpt-6.1-sol，改用该型号后 Router/Worker 推理成功。随后发现的个人 gh 登录误用及其修正、真实重测结果单独记录在 `2026-11-03-worker-credentials-fix.md`。经用户授权的重测已通过机器账号结果回复与重启去重，服务恢复运行。
