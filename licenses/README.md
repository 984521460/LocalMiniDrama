# 第三方许可证资料

本目录保存 LocalMiniDrama 改造项目的第三方许可证审计工具和后续经核验的许可证文本。根目录的 `THIRD_PARTY_NOTICES.md` 是当前分发边界与直接 NPM 依赖清单。

## 重建直接依赖清单

在仓库根目录执行：

```powershell
node licenses/collect-direct-npm-licenses.mjs
```

命令先运行通知表边界单元测试，再读取根工程与三个子项目的 `package.json`、`package-lock.json` 和根通知文件，全程不访问网络。锁文件中精确绑定到仓库内 `packages/*` 的私有一方工作区包不计入第三方清单；其他依赖缺少锁定版本、许可证元数据、依赖行或存在陈旧多余行时均以非零状态退出。

## 发布前要求

1. 直接依赖表必须与根工程及三个子项目的四个锁文件一致；
2. 打包所含的全部传递依赖必须保留其许可证文件和必要版权声明；
3. 当前 FFmpeg 可执行文件的本地自报告与哈希记录在根目录通知中；四套打包配置和发布归档门禁必须继续排除它，除非取得链、精确对应源码和随附材料另行闭合并重新审查；
4. 示例项目、截图、视频、字体、音乐、模型、LoRA、ComfyUI 节点和 Workflow 必须分别取得可分发证据；
5. 无明确许可证或来源的资产不得进入安装包。

`npm run licenses:check` 会同时执行 `distribution-policy.test.mjs`：四套 Electron Builder 配置只能携带前端构建目录，发布归档不得出现 FFmpeg、示例剧集或常见模型权重扩展名，实际可分发源码与已存在的生成输入也会被扫描。该机器门禁证明“当前配置排除了已知未闭合资产”，不等于对所有第三方许可证作法律结论。

本目录不存放模型权重或第三方二进制本体，也不把软件许可证推断为模型或生成内容的使用许可。

## H3 运行资产

`h3-runtime-assets.json` 是当前 MVP 远程 H3 环境的可机读来源与许可清单，固定：

- `Comfy-Org/MiniMax-H3` 的精确 revision、七个运行文件的仓库路径、字节数和 SHA-256；
- MiniMax H3 Community License 的有效约束，以及 Qwen3-VL 和 LightX2V 上游组件声明；
- `runtime-user-acquired`、`packaged: false` 和项目不得再分发权重的工程政策；
- 付费运行前必须由操作者确认地域、收入阈值、商业 UI 标识、下游条款和可接受使用要求。

`h3-runtime-assets.test.mjs` 将该清单与后端当前运行环境、前端授权合同及 H3 Profile 逐项交叉验证，同时确认 Phase 7 历史实测证据保持原始摘要，不用当前官方文件信息改写历史。该清单是工程合规证据，不是法律意见，也不代表已经替操作者完成许可资格判断。
