# 第三方组件与分发说明

> 审计基线：`321f5950f5984c21401bbd65f0c092610e5dabde`（应用版本 v1.2.8）
> 清单日期：2026-08-31
> 状态：P9-07 工程分发复核；不是法律意见

## 1. 上游源码

本项目基于 LocalMiniDrama。仓库根目录 `LICENSE` 声明其采用 MIT License，Copyright (c) 2026 xuanyustudio。保留并分发该许可证文本是后续发行的必要条件。

## 2. 直接 NPM 依赖

下表从根工程与三个子项目当前 `package.json` 与 `package-lock.json` 重建；精确绑定到本仓库 `packages/*` 的私有一方工作区包不属于第三方组件，故不重复列入。重建命令：

```powershell
node licenses/collect-direct-npm-licenses.mjs
```

| 子项目 | 类型 | 包 | 锁定版本 | 声明许可证 |
|---|---|---|---|---|
| root | devDependencies | `ajv` | `8.20.0` | `MIT` |
| root | devDependencies | `typescript` | `7.0.2` | `Apache-2.0` |
| backend-node | dependencies | `@volcengine/openapi` | `1.36.1` | `Apache-2.0` |
| backend-node | dependencies | `adm-zip` | `0.5.16` | `MIT` |
| backend-node | dependencies | `ajv` | `8.20.0` | `MIT` |
| backend-node | dependencies | `better-sqlite3` | `11.10.0` | `MIT` |
| backend-node | dependencies | `cors` | `2.8.6` | `MIT` |
| backend-node | dependencies | `express` | `4.22.1` | `MIT` |
| backend-node | dependencies | `js-yaml` | `4.1.1` | `MIT` |
| backend-node | dependencies | `jsonrepair` | `3.13.3` | `ISC` |
| backend-node | dependencies | `jsonwebtoken` | `9.0.3` | `MIT` |
| backend-node | dependencies | `multer` | `1.4.5-lts.2` | `MIT` |
| backend-node | dependencies | `sharp` | `0.34.5` | `Apache-2.0` |
| backend-node | dependencies | `ssh2` | `1.17.0` | `MIT` |
| backend-node | dependencies | `uuid` | `10.0.0` | `MIT` |
| frontweb | dependencies | `@element-plus/icons-vue` | `2.3.2` | `MIT` |
| frontweb | dependencies | `@vue-flow/background` | `1.3.2` | `MIT` |
| frontweb | dependencies | `@vue-flow/controls` | `1.1.3` | `MIT` |
| frontweb | dependencies | `@vue-flow/core` | `1.48.2` | `MIT` |
| frontweb | dependencies | `@vue-flow/minimap` | `1.5.4` | `MIT` |
| frontweb | dependencies | `axios` | `1.13.5` | `MIT` |
| frontweb | dependencies | `element-plus` | `2.13.2` | `MIT` |
| frontweb | dependencies | `pinia` | `2.3.1` | `MIT` |
| frontweb | dependencies | `vue` | `3.5.27` | `MIT` |
| frontweb | dependencies | `vue-router` | `4.6.4` | `MIT` |
| frontweb | devDependencies | `@vitejs/plugin-vue` | `5.2.4` | `MIT` |
| frontweb | devDependencies | `vite` | `5.4.21` | `MIT` |
| desktop | dependencies | `@volcengine/openapi` | `1.36.2` | `Apache-2.0` |
| desktop | dependencies | `adm-zip` | `0.5.16` | `MIT` |
| desktop | dependencies | `ajv` | `8.20.0` | `MIT` |
| desktop | dependencies | `better-sqlite3` | `11.10.0` | `MIT` |
| desktop | dependencies | `cors` | `2.8.6` | `MIT` |
| desktop | dependencies | `express` | `4.22.1` | `MIT` |
| desktop | dependencies | `js-yaml` | `4.1.1` | `MIT` |
| desktop | dependencies | `jsonrepair` | `3.13.3` | `ISC` |
| desktop | dependencies | `jsonwebtoken` | `9.0.3` | `MIT` |
| desktop | dependencies | `multer` | `1.4.5-lts.2` | `MIT` |
| desktop | dependencies | `sharp` | `0.34.5` | `Apache-2.0` |
| desktop | dependencies | `ssh2` | `1.17.0` | `MIT` |
| desktop | dependencies | `uuid` | `10.0.0` | `MIT` |
| desktop | devDependencies | `electron` | `28.3.3` | `MIT` |
| desktop | devDependencies | `electron-builder` | `24.13.3` | `MIT` |

版本与许可证字段来自当前锁文件。最终安装包还包含传递依赖；发布前必须保留各包自带许可证和必要版权声明，不能只依赖本表。当前桌面配置会把根 MIT `LICENSE` 与本通知放入 `resources/licenses/`，Windows 发布合同还要求 ASAR 中存在每个直接运行时依赖的许可证文件。

## 3. 当前仓库中的非 NPM 资产

| 路径/类别 | 当前事实 | P9-07 分发处理 |
|---|---|---|
| `backend-node/tools/ffmpeg/ffmpeg.exe` | 仓库中存在 99,264,000 字节的可执行文件（SHA-256 `5AF82A0D4FE2B9EAE211B967332EA97EDFC51C6B328CA35B827E73EAC560DC0D`）。其 `-version` 自报 `8.0.1-essentials_build-www.gyan.dev`，配置含 `--enable-gpl --enable-version3 --enable-static`；`-L` 自报 GPL v3-or-later。当前目录未找到可验证的取得来源记录、该二进制的精确对应源码提供安排或完整随附材料 | 仅保留为本地开发资产；四套 Electron Builder 配置和发布归档合同均明确排除 `resources/ffmpeg`。证据闭合前不得重新加入安装包 |
| `example_drama/衣服设计天才302.zip` | 当前 checkout 仅有 133 字节 Git LFS 指针，声明对象大小为 82,156,132 字节；本次本地审计未取得或核验实体文件，也未复现上游配额状态 | 仅保留为非分发开发资产；四套打包配置和发布归档合同明确排除 `resources/example_drama`。实体与授权证据齐备前不得重新加入 |
| `项目截图/*.mp4` 及其他演示素材 | 当前未形成逐项来源和再分发证据 | 发布前逐项核验；无证据则排除 |
| `backend-node/tools/ffmpeg/README.md` | 仅说明如何放置 FFmpeg，没有证明具体二进制的许可状态 | 保留操作说明，但不能替代分发审计 |

## 4. 模型、节点与 Workflow

软件源码许可证不自动授权以下资产：

- 模型权重、VAE、文本编码器、LoRA 和声音模型；
- ComfyUI 自定义节点及其 Python 依赖；
- 从第三方取得的 Workflow JSON、提示模板和示例素材；
- 音乐、音效、字体、角色参考图和生成内容。

Phase 1 起，每个资产必须登记来源、精确版本或哈希、许可证、商用与再分发条件、下载方式和是否进入安装包。默认策略是“运行时由用户在远程实例中按许可自行取得”，不把大模型权重打进桌面安装包。`licenses/distribution-policy.mjs` 会核验四套打包配置，并扫描实际可分发源码/生成输入中的常见模型权重扩展名；Windows 归档验证还会拒绝包内 FFmpeg、示例剧集和模型权重路径。

### 4.1 当前 MiniMax H3 MVP 运行资产

权威机器清单为 `licenses/h3-runtime-assets.json`。当前运行环境固定到 `Comfy-Org/MiniMax-H3` revision `4cc1d817b6184899b41293954329f576cb5ae86b`，七个文件的路径、字节数和 SHA-256 均由该 revision 的 Hugging Face 文件元数据逐项绑定；项目只验证运行时已有文件，不下载、不打包、也不授权再分发这些权重。

有效基础许可为 [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE)。工程采用前必须确认至少以下条件：

- 适用地域排除欧盟、英国、韩国和美国；排除地域使用需另行取得许可；
- 商业产品或服务年收入超过 2,000 万美元时需事先取得 MiniMax 书面授权；
- 商业产品界面须显著展示“MiniMax H3”；
- 必须遵守可接受使用政策、维护合理安全措施，并使下游用户受相应限制约束；
- 向公共环境发布生成内容时须清晰披露其为 AI 生成；
- MiniMax 不主张输出权利，但输出及后续使用责任由使用者承担。

Comfy-Org 的[模型卡](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/4cc1d817b6184899b41293954329f576cb5ae86b/README.md)说明其文件是面向 ComfyUI 的重新打包，并列出 MiniMax 原始仓库、LightX2V Turbo 上游和 Qwen 编码器来源。LightX2V Turbo 与 Qwen3-VL 上游分别声明 Apache-2.0；这些组件声明不会替代整个 H3 运行组合适用的 MiniMax H3 基础许可。

Phase 7 历史实测环境摘要 `541f91c7…c39f8` 被保留为发生过的历史证据，不因后来核对官方仓库而改写。当前 MVP 生产预检使用独立环境摘要 `716b53e4…52d43`；它采用官方 revision 中 Ref2VA diffusion 的 SHA-256 `9255f52b…65779` 与 Ref2VA Turbo LoRA 的 SHA-256 `5b9ab5ad…bb84c`，并要求每次付费执行前重新远端核验全部七个文件。

## 5. FFmpeg 工程判断依据

FFmpeg 官方说明：启用 GPL 组件会使相应构建适用 GPL，合规清单要求分发者提供与所分发二进制精确对应的源码和构建信息。FFmpeg 官方下载页把 Windows 二进制构建链接到第三方构建提供者；当前文件自报的 Gyan 构建也说明其静态变体采用 GPLv3。参考：

- <https://ffmpeg.org/legal.html>
- <https://ffmpeg.org/download.html>
- <https://www.gyan.dev/ffmpeg/builds/>

这些公开页面不能单独证明仓库内这一个 8.0.1 文件的取得链、精确源码对应关系和随附材料，因此当前工程结论是“不得分发”，而不是“已经合规”。用户如需本地媒体能力，应自行取得符合其使用与分发场景许可条件的 `ffmpeg`/`ffprobe`；项目不会把用户本地安装自动变成可再分发资产。

## 6. 发布阻断条件

存在以下任一情况时不得发布：

1. 安装包包含无来源或无许可证证据的二进制、模型或素材；
2. 应保留的许可证或版权声明未随包提供；
3. 安装包重新包含 FFmpeg、示例剧集或模型权重，但对应来源、许可和分发材料未逐项核验完成；
4. 锁文件与本清单不一致；
5. 把可运行、可下载或 API 可访问误当成可再分发。
