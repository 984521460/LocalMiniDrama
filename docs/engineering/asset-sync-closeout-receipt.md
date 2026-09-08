# 资产回收与离线导入收口工程回执

当前状态：`CANDIDATE_READY_FOR_DIRECTOR_REVIEW`。6609d665候选完整门禁退出0，总监已完成当前候选隔离实际UI验收；自建验收服务已停止，数据/日志保留。源码与测试定义持续冻结，Git仍未放行。完整门禁见第11节，UI验收来源与限制见第12节。

## 1. 任务身份与授权边界

- 执行任务：`01a07f38-e694-7af2-8253-30d6699e37e7`，`【AI漫剧工作流】工程执行负责人`。
- 总监任务：`01a0709e-ae38-7f61-a882-25c3dacc604b`，负责独立审查、集成与最终验收。
- 隔离工作区：`D:\project\AI漫剧工作流\.execution\asset-sync-20260908`。
- 隔离分支：`codex/asset-sync-closeout-20260908`；基线 HEAD：`8591c9c066dcd5d11b35c7949dae558c072d7827`。
- 冻结原仓：`D:\project\AI漫剧工作流\LocalMiniDrama`，本任务只读。
- 本任务未 stage、commit、push、发布或部署；未访问真实 SSH、ComfyUI、Provider、GPU 实例、凭据或用户小说正文；未写真实固定验收库、用户主库与既有 8 张素材。
- 模型 / 推理强度遥测：`UNKNOWN / UNKNOWN`（当前入口无可见遥测）；本任务未自行切换模型、强度或创建执行者。

## 2. 起点与冻结资产复核

- 开工前，隔离区 24 个候选文件与 `candidate-manifest.json` 逐项字节、SHA-256 一致，候选文件集 24/24 一致，index 为空，aggregate 为 `2b32e66b5338979ba0aa9ac743553eec609d291915f624c61508646b3c308bd5`。
- 封账前再次只读复核原仓：HEAD 仍为 `8591c9c066dcd5d11b35c7949dae558c072d7827`，分支仍为 `codex/phase-0-baseline`，index 为空；24 项候选逐项零差异，aggregate 仍完全一致。
- 原仓四项受保护 unstaged 删除仍为 `项目截图/微信群.jpg`、`ali.jpg`、`weixinpay.jpg`、`wx.jpg`，集合零漂移。本任务未恢复、清理或改动这些用户资产。
- 已应用于真实固定验收库的迁移 `0036_local_recovery_packages.sql` 未改写；所有修复采用追加迁移 0037/0038。

## 3. Finding-first 结论与关闭方式

### 已关闭的 P1 问题

1. 在线恢复对既有 `operationUid` 先返回旧结果、未复核请求摘要，变更请求可错误重放。现改为先核对持久化请求 SHA；同 UID 不同请求稳定冲突，并有 RED→GREEN 证据。
2. 本地 ZIP 原先先写文件再登记，进程退出、数据库回滚、并发实例和失败重试没有持久恢复边界。现新增迁移 0037 与 `localRecoveryPackageRepository`：先占位、再安装、最后原子提交业务记录；启动清理残留，失败可按同身份重试，跨实例由数据库唯一约束收敛，清理不完整进入 unknown 而不静默重做。
3. 在线与离线安装逻辑分叉。现抽出 `quarantineAssetInstaller`，共同承担校验后文件安装、Asset/AssetVersion/业务记录原子提交与失败清理，同时保留来源类型差异。
4. SFTP 下载会先远端整文件算摘要、再整文件下载，实际网络字节翻倍。现改为单次网络流边下载边计算本地 SHA/字节数，下载前后核对远端 stat；已用真实 1 MiB 合成 `.mp4` 字节证明完整下载只传一次，并证明已知期望 SHA 时 `.part` 断点只续传剩余字节。
5. 传输中断可能推动重复生成。现新增迁移 0038 的窄状态迁移与仓储重试接口：仅 `REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE` 的只读传输失败可回到 reserved；身份字段保持不可变，启动恢复只清理本任务 staging/output 残留，已有实际生成不重新提交。
6. v2.1 项目 ZIP 会丢失本地恢复来源及归一化媒体。现把本地导入 attempts/packages 纳入结构化归档、schema、catalog、导入顺序与媒体/来源证据校验；旧 v2.1 缺组归档通过兼容归一化读取，导出→导入→再导出往返有高层测试。

### 已关闭的 P2 问题

1. 角色来源变更后历史资产仍显示为当前来源。现保留历史文件与记录，并动态返回 `sourceCurrent`；前后端 schema/契约与界面均显示来源失效标签，恢复原身份后可重新判定为当前。
2. 离线导入前端使用宽松响应路径，角色切换、旧回包、失败可见性不足。现增加严格文本响应 envelope、严格本地恢复契约与 multipart API；组件加入 ZIP 类型/大小限制、角色请求守卫、刷新、成功提示、通用失败提示、来源失效标签和文件选择复位。
3. readiness 仍按迁移 36 和旧表集判断。现更新到迁移 38，并纳入新增表/触发器检查；相关历史测试同步到最新迁移号。

## 4. 主要代码与数据变化

- 追加迁移：`0037_local_recovery_import_attempts.sql`、`0038_remote_asset_recovery_transfer_retry.sql`；迁移 README 同步。0037 会将既有 v36 local package 记录一对一回填为成功 attempt，合成 v36 带记录升级测试已通过。
- 新增后端模块：持久本地恢复仓储、共享隔离区安装器；重构本地 ZIP 服务、在线恢复服务、SFTP 传输、远端协调器与启动恢复。
- 扩展 project archive v2.1、readiness、repository 聚合、路由错误映射、远端/本地来源当前性判断。
- 新增前端本地恢复响应契约、multipart API、导入面板；远端面板增加来源失效展示。
- 更新 v2.1 与 v9 JSON Schema，并新增/扩展数据库迁移、回滚、并发、断线续传、幂等冲突、来源漂移、路由、项目 ZIP 与前端契约测试。

## 5. 验证证据

### 缺陷 RED→GREEN

- 初始目标集：8/8 通过。
- 加入两条缺陷测试后：7/9 通过、2 失败，分别精确暴露“同 operationUid 不同请求仍成功”和“1 MiB 下载产生 2 MiB 网络读取”。
- 实现后同组：9/9 通过。

### 当前源码验证

- 后端变更与邻接覆盖集：`node --test` 17 个测试文件，155/155 通过，退出码 0；覆盖迁移、v36 回填、DB 回滚、启动清理、并发实例、远端传输重试、1 MiB 实字节续传、来源漂移、路由、项目 ZIP 往返与启动恢复。
- 前端全量：`npm run test:frontend`，178/178 通过，退出码 0。
- 集成测试：`npm run test:integration`，15/15 通过，退出码 0。
- E2E：设置仓内 FFmpeg 与已安装 ffprobe 路径后，12/12 通过，退出码 0。
- 许可证检查：18/18 通过，退出码 0。
- 生产构建：`npm run build` 通过，前端 1783 modules；最大 Element Plus chunk 433.96 kB（gzip 143.72 kB），未触发 500 kB 警告。
- 静态检查：42 个变更/新增 JS 文件 `node --check` 全通过；2 个变更 JSON Schema 可解析；`git diff --check` 退出码 0。
- 桌面端：沙箱内全量 39/40，通过项 39；唯一失败为日志轮转文件锁。将该测试文件按既有许可在沙箱外原命令重跑 3/3 通过，因此 40 个桌面测试均有通过证据，但不是单次全量绿灯。
- 原仓 MVP benchmark 校验脚本以冻结原文件直接运行通过，source / selected / license 摘要分别为 `323a...` / `20b...` / `d95c...`。

### 根级门禁的真实状态

- 按工作包要求仅一次执行根级 `npm run verify:mvp`：退出码 1，第一关因隔离 worktree 的 CRLF 字节与仓库 benchmark 固定 LF 摘要不一致而停止，未进入后续关口；冻结原仓同一 benchmark 内容直接校验通过。为测试临时复制的 LF benchmark 文件已还原为 worktree 原始 CRLF 字节，三个文件均不在最终 diff 中。
- 根级 `test:unit` 第一次为 954 pass / 80 fail / 1 skip，主要受 benchmark CRLF、缺少显式 FFmpeg/ffprobe 环境与沙箱原生日志锁影响；补齐本机现有工具路径并临时用冻结 benchmark 字节后第二次为 1021 pass / 13 fail / 1 skip。
- 未以同策略第三次重跑全量。已拆分核验：变更与邻接覆盖集 155/155；沙箱原生日志相关后端子集在沙箱外 26/26；桌面日志文件在沙箱外 3/3；前端、integration、E2E、license 与 build 如上通过。故本回执不声称单次根级全量绿灯。

## 6. 实际 UI 验收（合成隔离数据）

- 使用 `computer-use` 在隔离临时 DB/storage 与 loopback 5810 上运行 production build；未连接原仓应用、真实 DB 或既有素材。
- 阿澜与夏弦各 4 张实际可渲染 PNG 均显示；角色切换后路径与记录随角色变化，无跨角色串漏。
- 刷新后记录保留；无效合成 `.zip` 通过真实文件选择上传，页面显示可见失败信息。
- 有效合成夏弦 ZIP 通过真实文件选择上传，显示成功提示且列表从 1 增至 2；页面重载并重新切到夏弦后两条记录仍存在。
- 验收后已关闭浏览器标签、停止临时服务、删除 `.tmp\asset-sync-ui`；5810 无监听。5679/5680 的既有服务未停止、未占用、未修改。

## 7. 临时依赖与清理

- `npm run install:all` 在沙箱内因 npm cache 的 EPERM 失败；沙箱外安装授权未获通过，因此未下载、升级或修改依赖与 lockfile。
- 为完成隔离验证，临时创建四个目录 junction，只读复用原仓 root/backend/frontweb/desktop 的现有 `node_modules`；验证完成后仅删除这四个本任务 junction。原仓四个依赖目录复核均仍存在。
- 未保留测试 UI、临时 DB、临时 storage、临时端口或任务创建的依赖映射。

## 8. 剩余风险与总监复核重点

1. 根级 `verify:mvp` 和第二次 `test:unit` 没有形成单次全量绿灯；总监集成到规范换行/依赖环境后应重跑根级门禁。当前目标/邻接、前端、集成、E2E、license、build 与隔离出的原生日志测试均已通过。
2. 本任务没有真实 Featurize/SSH/ComfyUI/Provider 或真实用户 ZIP 验收；网络、远端权限、服务端 SFTP 实现差异与真实大文件性能仍需后续受控环境验证。
3. 字节级 `.part` 断点续传的实证路径要求调用方已知期望 SHA。协调器在未知期望 SHA 时仍保证只停留/重试传输阶段、不重复提交生成，但下次传输可从头读取；不得把前者的续传证据扩大为所有未知摘要调用均按字节续传。
4. UI 证据使用合成 PNG/ZIP/隔离 DB，只证明交互、隔离、持久化与错误可见性；真实既有 8 张素材与固定验收库由总监既有基线证据覆盖，本任务未重复读取或写入。
5. 总监应重点审查迁移 0038 的窄状态迁移、共享安装器的提交后不确定态、project archive 旧 v2.1 兼容归一化，以及 `sourceCurrent` 的动态身份判定。

## 9. Git 与交付状态

- 隔离 worktree 仍在 `codex/asset-sync-closeout-20260908`，HEAD 未移动，index 为空。
- 所有候选以 unstaged modified/untracked 形式保留；无 commit、push、PR、发布或部署。
- 本回执是第一阶段候选证据，不代表整个 MVP、视觉生图阶段或外部生产环境已完成。

`CANDIDATE_READY_FOR_DIRECTOR_REVIEW`

## 10. 2026-09-08 首轮返修记录（最新状态）

返修输入为 `DIRECTOR_REVIEW.md` 与52文件快照，开工逐项SHA/字节、aggregate、HEAD、分支/index全部一致：`5fcf9059426ae9a6d112470b60173d21ce4cbef8d23f4e2e0d36618db11827bf`。本轮按原60分钟回执边界推进，未自行切换模型或新增执行者；实际模型/强度遥测仍 UNKNOWN/UNKNOWN。

### 返修实现与针对性证据

- R1：在 pipeline 中先执行剩余声明字节上限，再写文件；超量立即销毁流并丢弃不可复用 partial。新增单块、多块、续传超量三项；原正常断线实字节续传测试保留通过。
- R2：前后 stat 明确支持 ssh2 的数值 `mtime`，本地适配器支持 `mtimeMs`；缺失可比时间或同大小mtime变化均拒绝。不再将缺少证据当作相同；仍只读取一次远端流。
- R3：既有 partial 只以只读句柄打开，打开前/后验证nlink、dev/ino/size，复制前缀到独立随机文件后才续写；不再使用既有文件的r+句柄。额外用同目标独占占用文件排除并发下载。硬链接原文件不变、打开时替换链接、第二实例同目标竞争均有回归。
- R4：增加 `localRecoveryItem.js`，只接受已知v36十字段或当前十一字段的精确形状；只对缺失logicalUri的旧合同计算确定URI，随后照常验证Asset/AssetVersion归属、路径、摘要、尺寸和实际媒体。已有错误URI、null、额外字段、路径逃逸仍拒绝。项目ZIP导出投影使用同一兼容边界。
- R4数据库证据：改正原“伪旧形状”测试，以不含logicalUri的真实v36字段形状入库，追加迁移后列表、两张合成PNG重读、重复ZIP导入均通过，原items_json字节不改。项目ZIP测试持久化同一旧字段形状，导出/导入/再导出通过。两项均在最终离线物理副本环境中重跑；不沿用镜像依赖上的首次GREEN。
- R5：Comfy输出名改为授权ordinal的实际计数文件名，不再固定00001；保留输出节点7、任务目录、output类型边界。00002测试先失败后通过；其他节点、其他任务、其他ordinal、路径逃逸共7/7通过。
- R6换行部分：仅为三个摘要保护的benchmark文件增加LF属性，规范化候选字节，未更改任何预期摘要。候选运行 `node scripts/validate-mvp-benchmark-source.js` 退出0。
- R7：实际活动下载/活动本地写入与第二实例启动清理交错，修复前两项失败。追加迁移0039与`recoveryActivityRepository`，执行和清理抢占同一数据库活动键；活动PID不被清理，仅确认PID不存在才回收，获取占用后重新读取reserved状态。两项修复后通过；另真实子进程/两个SQLite连接的活跃排除、进程退出后接管和释放测试通过。瞬态进程占用不进入项目归档。PID重用或权限不确定会保守保留占用，可能需后续人工处理，不能宣称所有旧环境均可自动接管。

Node内置模块回归29/29；总监两份外部只读断言在最终离线副本下重跑4/4（exit0）。R4/R7三项定向测试为修复前1 pass/2 fail，修复后3/3；旧字段ZIP往返1/1；跨进程所有权1/1。测试文件自身清理顺序曾出现EBUSY，调整为关闭SQLite后删除自有临时目录，随后通过；未修改业务断言。

### 依赖偏差与恢复处置

本轮发生镜像下载执行偏差，详见 `dependency-preparation-deviation.md`；不将其归因于“后来才增加限制”。新下载物已依总监明确裁定Move-Item到`.tmp/dependency-quarantine-20260908/{root,backend-node,frontweb}/node_modules`，缓存/日志保留原位，没有删除。移动前后摘要一致：root 1074项 `6b8725513a12c9a9b426a1d50fd5b84207d9f6631008cb52bd83cff4c4f74e61`；backend 3835项 `96f3bd02248d72f1870e840f0904b1a26228d099478fce596e4457bce5d682fc`；frontend 13125项 `4f58a2bdc7ab025542dba8c2e78e894705336bb97d10b20bd6e69769885442ea`。

然后从冻结原仓建立独立物理副本。root1074、backend3120、frontend13161、desktop9020项；第三方文件逐项SHA相同，复制期间源摘要前后相同；仅7个认可workspace链接重建指向隔离packages。backend的5个提升依赖（ajv等）按锁定版本验证并解析至隔离root。better-sqlite311.10.0在Node22.22.3/ABI127实际加载成功，其二进制SHA为`c6770a96c516d2b3e78308ecfcc146c38c0eb0875e180c8028d77f1e93914c6d`。未运行新的原生安装脚本；完整门禁中的项目既有原生构建仅从本仓源码在隔离区编译。

可核验证据：`.tmp/dependency-quarantine-before.json`、`.tmp/offline-dependency-evidence.json`、`.tmp/offline-dependency-audit.cjs`。`.tmp`与`.npm-cache`仅为任务证据/缓存，明确排除候选提交；不修改全局Git忽略配置。

### 调用链事实与覆盖限制

| 路径 | 实际下载/安装/登记边界 | 本轮证明范围 |
|---|---|---|
| 在线手工/历史图片回收 | remoteAssets/service → downloadScopedFile → quarantineAssetInstaller → remoteAssetRecoveries.complete | 与离线导入共用安装器；有摘要、隔离、重试和旧来源测试 |
| 离线图片ZIP | localPackageImportService → 图片规范化 → quarantineAssetInstaller → localRecoveryPackages.complete | v36兼容、重复导入、媒体重读、归档往返 |
| 正常角色候选图片 | remoteComfyImageProvider → client.downloadOutput → characterCandidates/execution/service的storage.write与独立事务登记 | R5真实history文件名；尚未与隔离区安装器统一 |
| 正常远端图片/视频任务 | remoteExecutionCoordinator → downloadFile → outputVerifier.verify → assets.addVersion/生成历史事务 | 复用单流SFTP传输；登记仍为独立现有路径 |

共享安装器目前仅覆盖两种隔离区图片来源；没有用本次修复展开全仓统一。1MiB `.mp4` fixture是合成字节，证明网络读取量、哈希、断点，不证明视频可播放；真实SSH/Comfy/GPU/用户ZIP、用户主库与既有8张PNG未用于本轮。

### 完整门禁与追加阻断修复

`npm run verify:mvp` 使用隔离离线副本运行，环境显式指定本机已有FFmpeg/ffprobe，日志`.tmp/revision-verify-mvp.log`，工具会话45982。运行期间生产源码和测试定义保持冻结。候选代码快照`.tmp/revision-gate-source.json`（排除docs的code aggregate `880f3ec30cbf9c578783316bc10a25eb8cb2617c86cbc4eba96c1e875d99995c`）。目前已见三个`v3NarrativeBenchmark`失败，不能宣称完整门禁通过。

第一次门禁已完整退出1：后端1053 pass/7 fail/1 skip。7项为3个源正文摘要问题、3个新增归档组的旧fixture/集合遗漏、1个旧fastGet磁盘错误注入未命中。保留`.tmp/revision-verify-mvp.log`与`revision-gate-source.json`，不拼接为全量通过。

该次门禁结束后，总监追加明确授权R8/R9，执行以下有限修复：

- R8：独立子进程复现文件锁在进程死亡后遗留，外部断言0/1。新增`downloadOwnership.js`，以本机IPC监听器形成操作系统管理的排他占用，进程退出即释放；`.part.lock`只保存受限PID/token/请求binding元数据，以确定路径追溯该次私有临时文件。活跃占用不可抢，死亡PID才能回收，不按文件年龄删除、不扫描整个目录。当前真实自有子进程被终止后同请求重试、内容读取通过，仓内测试同时证明活跃进程时第二次请求被拒绝；总监R8外部断言1/1通过。
- R9：总监确认新导入持久化应使用`normalizedTextSha256`匹配规范化fullText，允许仅修改该映射与相关回归。原始contentSha256/字节检查、编码器、证据验证器和黄金摘要保持原语义。LF、CRLF、UTF-8 BOM三种原始摘要仍互异；导入→getDocument→选择→备份并重开SQLite读取全部通过；原有3个叙事benchmark回归通过。未批量修复旧记录或写真实库。
- 归档：两个结构组已补真实合成PNG→ZIP导入记录，保留“每个组有记录”的断言；不靠排除新组求绿。新增通用fixture供两个归档测试使用，7/7通过。迁移39的machine-local ownership加入明确excludedTables，归档期间放入非空占用并验证PID字段/owner token不外带。
- 磁盘故障：改在实际createWriteStream写入边界注入ENOSPC，断言故障至少命中一次；保持不登记AssetVersion、不重复submit、失败分类与无残留的断言，扫描扩展至`.part.*`私有产物。故障矩阵通过。
- 可播放视频：新增`v6SftpPlayableVideo.test.js`，本机FFmpeg创建1秒128x128合成MP4，经单流SFTP适配器传输后验证完整字节、本地SHA与网络读取量，再实际ffprobe确认尺寸/时长并以FFmpeg解码。该证据区别于原1MiB随机字节测试，仍不是实际SSH生产验证。

第二次完整门禁已启动：`.tmp/revision-verify-mvp-final.log`，工具会话67255，源码快照`.tmp/revision-gate-source-final.json`，74个候选文件（排除任务缓存/证据），code aggregate `0f83124ebd8b3493157833efa7127eebedee0d437956537605b622c8c7f05691`。门禁期间继续冻结生产源码及测试定义，最终退出待追加。

第二次门禁后续状态：总监追加复现R8元数据写入ENOSPC会遗留空锁。按其允许的精确自有会话中止方式向67255发送Ctrl-C，工具明确exit1；随后进程查询没有遗留verify/run-node-tests子进程。此运行记为**中止**，未到完整退出判定，不能算门禁通过。

中止并确认进程结束后修复R8元数据发布：先向包含PID/token的自有pending文件写入完整JSON并sync，之后通过不覆盖既有名称的link原子发布；失败仅清理本次pending，不删除未知已发布锁。发布后、pending删除前崩溃留下的双链接，只在其inode、nlink和metadata推导的路径全部匹配时回收。发布前中止可能保留未发布metadata pending（可从文件名追溯PID/token）；没有资产内容写入，也不会阻止重试，未扫目录批量清理。

新增仓内回归3/3：真实metadata写ENOSPC命中、sync后发布前子进程终止、流中子进程终止；流中测试同时保留活跃请求拒绝。总监新增ENOSPC外部断言与传输邻接共15/15通过。

第三次门禁运行中：工具会话58981，`.tmp/revision-verify-mvp-final-r8.log`，对应`.tmp/revision-gate-source-final-r8.json`，74文件；code aggregate `e79089236f478cb578d13ff0562a2f7c17ecbb83045bff7cf73b610a78bdcd55`。这是R8新增缺陷修正后的新候选门禁，生产源码/测试定义再次冻结；08:09 UTC为原60分钟主动回执边界，不重置计时。

最终环境中的独立外部断言6/6、exit0，日志`.tmp/revision-director-assertions-final-r8.log`；总监也对同一code aggregate独立取得6/6。它仅证明指定边界，不替代完整门禁。

明确未验证项：R8的**单次进程崩溃恢复**、元数据写失败与发布前中止已经实测；**接管本身再次崩溃**未实测。只读分析显示，在死亡owner的priorFile硬链接为temporary之后、删除priorFile之前若恢复器又终止，下一次可能因prior.nlink=2保守拒绝。本轮冻结期间不修改这一边界，不能泛称任意中断点都可重入；交总监下一步裁定。

门禁与可播放MP4测试使用的工具路径仅为：`FFMPEG_PATH=D:\project\AI漫剧工作流\LocalMiniDrama\backend-node\tools\ffmpeg\ffmpeg.exe`；`FFPROBE_PATH=C:\Program Files\Krita (x64)\bin\ffprobe.exe`。没有读取或包含凭据。

清理限制：一次失败所有权测试留下的自建OS-temp目录`lmd-recovery-ownership-Go4ecd`，精确路径清理命令被自动安全策略拒绝，仅返回“blocked by policy”。未删除、未重试绕过，目录保留。该限制不涉及候选源码或真实用户数据，也不阻止测试继续。

### 60分钟主动回执边界

截至08:08 UTC，第三次门禁已得到后端1065 pass/0 fail/1 skip（1066 tests）；其余关口仍由同一会话58981顺序执行，尚不能写为整体通过。受检生产源码与测试定义code aggregate仍为`e79089236f478cb578d13ff0562a2f7c17ecbb83045bff7cf73b610a78bdcd55`，复核零漂移，HEAD未移动、index空。

总监独立证据：当前6项外部断言通过；所有权、规范化源文档、SFTP崩溃测试共5/5通过；真正可播放MP4传输另1/1通过。均不替代完整门禁。08:09边界后只等待已启动的58981，不修改源码/测试、不安装或开启新测试波次；多次接管崩溃边界继续标为未验证，等待总监裁定。

### 最终收取结果与停止写入

08:09边界后仅收取既有会话58981，其最终退出码为0；没有新增测试波次或修改生产源码/测试定义。以下均来自同一次 `npm run verify:mvp` 连续执行：

| 关口 | 结果 |
|---|---|
| benchmark source | VERIFIED，原黄金摘要不变 |
| licenses | 18/18 |
| packages | domain15、storage5、credential-vault3、workflow-engine8，全部通过 |
| backend unit | 1065 pass / 0 fail / 1 skip（1066 tests） |
| frontend unit | 178/178 |
| desktop unit | 40/40 |
| integration | 15/15 |
| E2E | 12/12 |
| build | 全部包与前端成功，1783 modules，Vite 16.50秒 |

唯一skip为既有Windows Credential Manager合成entry实机往返测试，本轮没有启用Vault操作；不得声称真实凭据设施已验。最终日志 `.tmp/revision-verify-mvp-final-r8.log` SHA-256：`64d934187fb2cdb79bf7267bff51f236b01d4876c90bc236f569db52636abe97`。

门禁结束后代码文件SHA复核零漂移，`git diff --check`退出0，HEAD仍为`8591c9c066dcd5d11b35c7949dae558c072d7827`，index空。最新74文件精确候选快照保存于`.tmp/revision-final-candidate.json`；其code aggregate仍为`e79089236f478cb578d13ff0562a2f7c17ecbb83045bff7cf73b610a78bdcd55`。`.tmp`与`.npm-cache`是保留证据/缓存，不在候选提交集合。

本轮修复及当前完整门禁结果已形成候选；接管再次崩溃、未发布metadata pending的后续清理、真实SSH/Comfy生产兼容仍保留限制。未触碰真实库/8张媒体/四项截图删除，未stage/commit/push/集成/部署，未启动新执行者或外部付费活动。依赖下载偏差不因后续离线验证通过而被追认。

`CANDIDATE_READY_FOR_DIRECTOR_REVIEW`

## 11. 接管重入原子收口（2026-09-08 08:18 UTC开始）

授权依据为总监 `RECOVERY_REENTRY_CLOSEOUT.md`。30分钟主动回执边界为08:48 UTC；不切模型、不新增角色、不改依赖、不改数据库/Schema/源文档/前端，不触及真实数据或Git写操作。入口使用既有`orchestrate-project-execution`全模式章程与本包边界。

开始逐项验证74文件原最终快照：aggregate `c4021987b53450df367486a684f28deef1bf431d3a4298bfd885072b655639fe`，code aggregate `e79089236f478cb578d13ff0562a2f7c17ecbb83045bff7cf73b610a78bdcd55`，HEAD不变、index空。原已知未验证边界现由总监真实双子进程复现为P2可用性缺陷；本次先复现外部套件2/3、exit1，失败是接管link完成但unlink前退出后，第三次请求错误冲突。

### 有限状态与处理闭包

记L为已发布lock、M为其PID/token派生pending、D为已死owner的private、P为确定partial；数字为各自nlink，`=`表示同一dev/ino与大小。仅在取得IPC排他权、元数据规范且binding相同、原PID确认死亡后进入数据恢复。

| 可追溯状态 | 操作和后继状态 |
|---|---|
| L2=M2（精确两个元数据名字） | 验证inode后移除M，成为L1；再次退出仍可从L1恢复 |
| L1、D0/P0 | 没有数据需要接管，清理已知L后新占用 |
| L1、D1/P0 | link D到P，成为D2=P2；该中间状态现在被明确接受 |
| L1、D2=P2（精确两个数据名字） | 两条路径重复核验inode/大小/nlink，再unlink D，成为D0/P1 |
| L1、D0/P1 | 保留P，清理已知L；再次退出仍保留单链接P |
| L1、D1/P1、inode不同 | 只接受D不长于P且D字节严格等于P前缀的复制中断态；只读句柄及路径复核后移除D，保留完整P |
| L0/P1 | 新占用后沿原COW续传路径使用P；仍不直接r+修改旧文件 |
| 无L、仅未发布M | 不视作完成锁；不阻止新请求，也不扫描或删除未知pending |

其他组合（未知第二链接、第三链接、错误inode、软链接、错误binding、活动/不确定PID）全部拒绝。元数据双链接与五种数据状态的笛卡尔组合均有回归；不将任意nlink=2视为可恢复。最终目标文件已存在仍保持既有冲突边界，不覆盖终态资产。

实现仅修改`downloadOwnership.js`的数据名字恢复边界，未改sftpTransfer、数据库或公共Schema。新增`v6SftpReentryStates.test.js`，扩展`v6SftpCrashRecovery.test.js`；未修改总监外部断言。

### 本包目标验证

- 真实双子进程：第二进程分别在link D→P之后、unlink D之后、unlink L之后、unlink元数据M之后终止，第三次同请求完成且目录最终只保留输出文件；每项同时验证第二进程活跃时不可抢占。
- 状态矩阵10项：五种数据状态×元数据单/双链接，都有合法后继且重复获取/释放后内容不变。
- 负例9项：错误inode、未知外部硬链接、第三链接、partial外链、目录软链接、无关前缀、活动owner、错误binding、未知元数据链接均拒绝且外部字节不变。
- 旧元数据ENOSPC、发布前进程退出、流中退出、接收字节上限、普通断线续传、可播放MP4传输全部保留通过。
- 一次组合命令46/46、exit0，日志`.tmp/reentry-target-regressions.log`。其中包含总监原传输三断言和更新后的接管三断言。实现一轮即通过，未消耗新证据修正机会。

### 新候选完整门禁与交回

新冻结快照`.tmp/reentry-gate-source.json`：75文件，code aggregate `6609d6656111ee1af97e398ee2135132cfe5b8c250cf4c454e394718d550f3ce`。声明该摘要后，本包仅运行一次`npm run verify:mvp`（工具会话22307），最终退出0。此前e790的exit0只作为起点历史，不计入本包完成。

同一次运行得到：benchmark VERIFIED、license18/18、工作区包15+5+3+8全部通过、后端1088 pass/0 fail/1 skip（1089 tests）、前端178/178、桌面40/40、integration15/15、E2E12/12、全部构建成功（1783 modules，Vite17.86秒）。唯一跳过仍为既有Windows Credential Manager实机合成条目测试，未启用Vault操作。

- 完整日志：`.tmp/reentry-verify-mvp.log`，SHA-256 `ad8c1d58d53140b77372de6f312cf4e5b126186d7ba074ae04521ccf2da129e9`。
- 目标日志：`.tmp/reentry-target-regressions.log`，SHA-256 `5a8d6dc2a79e1b02fcb0d19bc39d0d6cf3a95aad975ed5abd35480567e72a173`。
- 总监已对该6609候选独立取得7/7、exit0，含真实双进程接管重入及原传输/v36断言；本记录不代替其最终Git裁定。
- 门禁前后代码摘要零漂移，`git diff --check`退出0，HEAD仍为`8591c9c066dcd5d11b35c7949dae558c072d7827`，分支`codex/asset-sync-closeout-20260908`，index空。
- 最终75文件快照：`.tmp/reentry-final-candidate.json`；仅本包四个文件变化（downloadOwnership、崩溃测试、状态矩阵测试、回执），相对上一候选没有其他代码变更。

本包08:18开始、08:36收取完整结果，未超过08:48主动回执边界。实现一轮通过，未开启修正波次。既有离线依赖和工具路径不变，无下载/安装、新原生脚本、切模型、新执行者、真实库/媒体/服务修改及Git写操作；此前被安全策略阻止清理的目录未再尝试处理。

明确边界：已实测的是列明的接管link/unlink状态闭包与负例，不宣称真实SSH服务器、真实断电持久性或恶意本地进程在所有系统调用间竞态均已验证。未发布metadata pending仍可保留且不阻断重试；终态目标文件不被覆盖。接管重入原P2已由本包实测关闭，不再标作未验证。

`CANDIDATE_READY_FOR_DIRECTOR_REVIEW`

## 12. 总监最终实际UI验收与服务收尾

证据来源：总监任务`01a0709e-ae38-7f61-a882-25c3dacc604b`完成浏览器操作后发送的正式验收回执。执行者仅准备合成环境与补查数据库，没有将自己未执行的浏览器操作声明为亲自观察。

使用6609d665冻结代码与既有production build，环境仅位于`.tmp/director-ui-final`，服务为`127.0.0.1:5810`。两角色、正文、ZIP和图片均为合成；阿澜持久化记录保留v36十字段形状（不含logicalUri），并非读取真实历史库。没有新增构建、安装或源码/测试定义改动。

总监报告的实际观察：

- 阿澜旧v36形状记录的4张PNG正常渲染。
- 通过真实文件选择上传invalid.zip后出现明确失败提示，记录没有增加。
- 切换夏弦仅显示该角色记录；上传upload-xia.zip新增4图记录`a860d141-61a8-4cff-bbc5-4bf04fc8a726`，保留原`9256de0a-511f-4cb6-8d0c-2659fe3ac614`。
- 再次选择同一ZIP导入仍为两条记录/8图，成功提示明确仍需人工审核。
- 刷新页面后阿澜原记录仍在，切回夏弦两条记录/8图仍在；预览链接返回实际256×256 PNG。
- 总监未触发生成或审核按钮，验收后已关闭自建两个标签。

执行者只读独立补查：合成数据库阿澜1条、夏弦2条，各条均4图，新增UID与总监回执一致。该补查仅证明持久化数量/身份，不代替总监的视觉观察。

停止前复核Node PID9752、命令`node.exe server.cjs`、启动会话6764及其已记录cwd`.tmp/director-ui-final`，server-state PID一致；OS监听记录为127.0.0.1:5810且owner9752。仅向自建会话6764发送Ctrl-C，工具返回exit1（中断退出，非声称正常exit0）；随后PID9752不存在、5810监听数0。未停止其他进程或5679/5680/3013服务。

DB、ZIP、storage、fixture、seed/server脚本及日志全部保留于`.tmp/director-ui-final`，未清理其他临时目录。停止后原75文件快照仍逐项一致，完整门禁日志SHA仍为`ad8c1d58d53140b77372de6f312cf4e5b126186d7ba074ae04521ccf2da129e9`；本次最终快照`.tmp/ui-final-candidate.json`仅允许此回执变化，code aggregate保持`6609d6656111ee1af97e398ee2135132cfe5b8c250cf4c454e394718d550f3ce`，HEAD不变、index空。未stage/commit/push/集成；等待总监Git裁定。
