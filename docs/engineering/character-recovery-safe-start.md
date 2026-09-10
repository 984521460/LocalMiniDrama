# 正常候选续收与原生离线安全模式

## 已提交候选继续回收

正常remote-comfyui候选POST先持久化操作/ordinal提交意图，收到promptId后写入确认，再绑定history输出并下载。每张核验后独立落盘并登记draft资产；后续失败不会删除已登记图片。继续回收只处理已确认prompt，绝不提交未生成的ordinal。

提交已接受但确认落库失败的窗口仍显示提交未知，不能推测恢复。仅提交了1–3张时显示各ordinal状态，不伪装完整批次。4张全部核验后沿原成功合同封成候选batch，为本批新资产设置唯一技术currentVersion；角色身份锁与审核结论不改变。

新接口：原candidate-executions POST完整成功保持旧响应，部分/待续收响应为character-candidate-recovery.v1。GET `.../characters/:uid/candidate-recoveries`读取状态；POST `.../candidate-recoveries/:operationUid/recover`（空对象）只继续回收。前端展示已保存数量、未提交/未知ordinal，可载入已完成的原生候选批次。

## 原生安全启动

创建专用本地dataRoot，配置JSON只能包含app/server/database/storage。数据库与storage必须是dataRoot内互不重叠的绝对路径，路径不得有链接。示例结构：

```json
{"app":{"name":"本地安全副本","version":"1"},"server":{"host":"127.0.0.1","port":5830,"insecure_tls":false},"database":{"type":"sqlite","path":"替换为dataRoot内绝对DB路径"},"storage":{"local_path":"替换为dataRoot内绝对storage路径"}}
```

使用进程环境`LMD_DATA_ROOT`、`LMD_SAFE_CONFIG`指向上述目录和JSON后，运行`node scripts/start-offline-safe.cjs`。也可在正式server入口显式设置`LMD_STARTUP_MODE=offline-safe`。缺少/错误范围在默认配置读取、数据库选择及目录创建前拒绝。数据库单例已有不同路径/模式时拒绝，不复用其他库。

安全模式通过原生createApp及router运行，禁用外部runtime、VendorLock修改和全部startup恢复执行；GET下载/导出/生成以及危险POST均由后端拒绝，不可通过浏览器参数切回正常模式。能力接口`/api/v1/runtime-capabilities`供实际前端显示模式和限制。本地资料、历史素材与离线ZIP导入仍可使用；远端续收只读显示且不可执行，连接未校验与源事实失效分开表达。

正常模式默认行为保留；进入有外部能力的正常模式需要明确配置并重启，不是前端开关。本模式不授予真实生成、GPU或费用权限。
