# 返修依赖准备偏差影响回执

状态：新下载依赖停用并已按总监裁定可恢复隔离；后续测试使用独立离线副本。时间均为 2026-09-08 UTC。

原 WORK_PACKAGE 已限定官方源。执行者在未检查 lock resolved 和项目 .npmrc 的情况下运行禁脚本 npm ci，导致 backend/frontend 实际从镜像 CDN 下载。此为执行偏差，不归因为后续才增加的限制。

## 命令、会话与结果

三处精确命令均为：

```text
npm ci --ignore-scripts --no-audit --no-fund --cache D:\project\AI漫剧工作流\.execution\asset-sync-20260908\.npm-cache
```

| cwd（隔离根下） | 日志开始 UTC | 日志最后写入 UTC | 工具会话 | 最终结果 |
|---|---|---|---|---|
| 根 | 07:11:15.204 | 07:11:19.810 | 无长驻会话，chunk 0dc7de | exit 0，11 packages |
| backend-node | 07:12:14.736 | 07:12:43.024 | 87036 | exit 0，190 packages |
| frontweb | 07:12:53.015 | 07:13:27.227 | 10899 | exit 0，91 packages |

frontend 在收到收窄后发送 Ctrl-C 时已经完成，write_stdin 返回明确 exit 0；不是仅发出中断或仍在运行。未启动 desktop 安装。只读进程查询未发现剩余 npm ci。

安装写入根为各自 node_modules；缓存和三份日志位于本隔离根 `.npm-cache`。日志、缓存、安装物均保留，未删除、回滚或掩盖。

## 实际网络与配置

仅从本次三个 npm 日志提取协议和主机，不输出完整 URL：

- root：8 条 `https://registry.npmjs.org` fetch。
- backend：182 条 `https://cdn.npmmirror.com` fetch。
- frontend：72 条 `https://cdn.npmmirror.com` fetch。
- 未见 HTTP 请求记录。日志记录不能证明所有潜在网络或运行副作用均不存在。
- backend 项目 `.npmrc` 含 `strict-ssl=false`；命令未覆盖，`NPM_CONFIG_STRICT_SSL` 环境不存在。该项目配置据此生效，不能声称 TLS 证书验证已严格执行。root/frontend 没有项目 `.npmrc`。
- npm 日志记录尝试加载 `C:\Users\98452\.npmrc` 和 `C:\Users\98452\AppData\Roaming\npm\etc\npmrc`；只读元数据核验两者不存在。没有读取或输出用户级配置秘密。
- 三命令 argv 均有 `--ignore-scripts`；三日志 `info run` / `silly lifecycle` 行数均为 0；未另行执行第三方生命周期或原生安装脚本。

## 文件与依赖边界

- root/backend/frontweb/desktop 共8个 package.json/package-lock.json 的 git diff 均为空，逻辑内容与 HEAD 相同。backend/frontweb/desktop lockfile 的字节 SHA 与冻结原仓一致；部分其他文件与原仓字节差异为 worktree 原有 CRLF，未据此声称新修改。
- 递归检查三份安装产物只有7个 workspace junction，全部指向本隔离根 packages；没有链接指向原仓或其他目录。
- 本轮未使用原仓 node_modules junction。安装没有到原仓的内部 workspace 链接；未手工改原仓。
- 上轮原仓依赖未留完整内容前后摘要，因此无法追溯证明全部无副作用。当前源 packages/dist 抽样时间为02:25 UTC，早于上轮执行，但抽样不能替代完整证明。此前回执“目录仍存在”仅证明存在，不证明内容未变。

## 已执行测试的依赖来源

- R1–R3 外部断言和新增 SFTP 边界8项只依赖 Node 内置模块。
- 本轮 R4 RED（安装前）通过显式 NODE_PATH 读取原仓已有依赖。
- R4 首次 GREEN 发生在 backend 安装后，解析路径为隔离 `backend-node/node_modules/sharp`、`adm-zip`。随后 better-sqlite3 探测也加载本批隔离 JS，但因未执行安装脚本而缺少原生绑定。
- 收到停用后未继续通过本批依赖进行测试/构建。后续只有 Node 内置模块可独立运行的回归。该 GREEN 当前仅为执行者候选证据，不能替代总监独立复核。

原安装安全拒绝原文原因：“依赖安装会从外部注册源下载并执行潜在不可信的包脚本、写入隔离工作树；未见可信用户内容明确授权该外部安装操作。”本轮禁脚本缩小了脚本风险，但未落实官方源与严格 TLS，故不能视为已满足边界。

## 总监裁定后的已完成处置

三份安装目录已逐项核验物理目录、隔离根及不存在的目标后，通过原生PowerShell Move-Item移至 `.tmp/dependency-quarantine-20260908/{root,backend-node,frontweb}/node_modules`。移动前后1074/3835/13125条文件与链接摘要完全一致；`.npm-cache`及三日志未移动或删除。总监独立运行after核验同样exit0。

四处新的node_modules均来自冻结原仓的独立物理复制。锁定版本匹配；root1074/backend3120/frontend13161/desktop9020条逐文件SHA验证；复制期间源前后摘要一致。认可workspace链接只重建至隔离packages。root离线副本最终物理文件集合/摘要与源一致，证据补全于 `.tmp/offline-dependency-evidence.json`。复制脚本是本地离线文件操作，不含网络、安装脚本或锁文件重写。

第二次完整门禁使用这些离线副本，未使用隔离保留的新下载包；NODE_PATH未指向原仓或隔离保留目录。内置模块解析检查显示better-sqlite3/sharp来自隔离backend，ajv来自隔离root。门禁环境复用已安装的FFmpeg/ffprobe可执行文件，仅对测试自有媒体操作。原生SQLite已有二进制在Node22/ABI127加载；没有运行第三方原生安装脚本。
