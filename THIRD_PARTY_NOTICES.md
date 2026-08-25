# 第三方组件与分发说明

> 基线：LocalMiniDrama `7b6c1a748e9e3013b88a902cfbfd31ec283da0d1`（v1.2.8）
> 清单日期：2026-08-25
> 状态：Phase 0 审计基线；不是法律意见

## 1. 上游源码

本项目基于 LocalMiniDrama。仓库根目录 `LICENSE` 声明其采用 MIT License，Copyright (c) 2026 xuanyustudio。保留并分发该许可证文本是后续发行的必要条件。

## 2. 直接 NPM 依赖

下表从三个子项目当前 `package.json` 与 `package-lock.json` 重建。重建命令：

```powershell
node licenses/collect-direct-npm-licenses.mjs
```

| 子项目 | 类型 | 包 | 锁定版本 | 声明许可证 |
|---|---|---|---|---|
| backend-node | dependencies | `@volcengine/openapi` | `1.36.1` | `Apache-2.0` |
| backend-node | dependencies | `adm-zip` | `0.5.16` | `MIT` |
| backend-node | dependencies | `better-sqlite3` | `11.10.0` | `MIT` |
| backend-node | dependencies | `cors` | `2.8.6` | `MIT` |
| backend-node | dependencies | `express` | `4.22.1` | `MIT` |
| backend-node | dependencies | `js-yaml` | `4.1.1` | `MIT` |
| backend-node | dependencies | `jsonrepair` | `3.13.3` | `ISC` |
| backend-node | dependencies | `jsonwebtoken` | `9.0.3` | `MIT` |
| backend-node | dependencies | `multer` | `1.4.5-lts.2` | `MIT` |
| backend-node | dependencies | `sharp` | `0.34.5` | `Apache-2.0` |
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
| desktop | dependencies | `better-sqlite3` | `11.10.0` | `MIT` |
| desktop | dependencies | `cors` | `2.8.6` | `MIT` |
| desktop | dependencies | `express` | `4.22.1` | `MIT` |
| desktop | dependencies | `js-yaml` | `4.1.1` | `MIT` |
| desktop | dependencies | `jsonrepair` | `3.13.3` | `ISC` |
| desktop | dependencies | `jsonwebtoken` | `9.0.3` | `MIT` |
| desktop | dependencies | `multer` | `1.4.5-lts.2` | `MIT` |
| desktop | dependencies | `sharp` | `0.34.5` | `Apache-2.0` |
| desktop | dependencies | `uuid` | `10.0.0` | `MIT` |
| desktop | devDependencies | `electron` | `28.3.3` | `MIT` |
| desktop | devDependencies | `electron-builder` | `24.13.3` | `MIT` |

版本与许可证字段来自当前锁文件。最终安装包还包含传递依赖；发布前必须保留各包自带许可证和必要版权声明，不能只依赖本表。

## 3. 当前仓库中的非 NPM 资产

| 路径/类别 | 当前事实 | Phase 0 处理 |
|---|---|---|
| `backend-node/tools/ffmpeg/ffmpeg.exe` | 仓库中存在 99,264,000 字节的可执行文件（SHA-256 `5AF82A0D4FE2B9EAE211B967332EA97EDFC51C6B328CA35B827E73EAC560DC0D`）。其 `-version` 自报 `8.0.1-essentials_build-www.gyan.dev`，配置含 `--enable-gpl --enable-version3 --enable-static`；`-L` 自报 GPL v3-or-later。当前目录未找到可验证的取得来源记录、对应源码提供安排或随附 GPL 文本 | `desktop/package.json` 当前会把整个目录复制进 `extraResources`；在来源与该构建的分发材料逐项核验完成前，不得让此文件通过发布门禁 |
| `example_drama/衣服设计天才302.zip` | 当前 checkout 仅有 133 字节 Git LFS 指针，声明对象大小为 82,156,132 字节；本次本地审计未取得或核验实体文件，也未复现上游配额状态 | 不作为测试 fixture，也不作为安装包验收依据；实体和授权证据齐备前不得进入发布包 |
| `项目截图/*.mp4` 及其他演示素材 | 当前未形成逐项来源和再分发证据 | 发布前逐项核验；无证据则排除 |
| `backend-node/tools/ffmpeg/README.md` | 仅说明如何放置 FFmpeg，没有证明具体二进制的许可状态 | 保留操作说明，但不能替代分发审计 |

## 4. 模型、节点与 Workflow

软件源码许可证不自动授权以下资产：

- 模型权重、VAE、文本编码器、LoRA 和声音模型；
- ComfyUI 自定义节点及其 Python 依赖；
- 从第三方取得的 Workflow JSON、提示模板和示例素材；
- 音乐、音效、字体、角色参考图和生成内容。

Phase 1 起，每个资产必须登记来源、精确版本或哈希、许可证、商用与再分发条件、下载方式和是否进入安装包。默认策略是“运行时由用户在远程实例中按许可自行取得”，不把大模型权重打进桌面安装包。

## 5. 发布阻断条件

存在以下任一情况时不得发布：

1. 安装包包含无来源或无许可证证据的二进制、模型或素材；
2. 应保留的许可证或版权声明未随包提供；
3. 安装包包含该 FFmpeg 二进制，但其来源记录和 GPL v3-or-later 分发材料尚未核验完成；
4. 锁文件与本清单不一致；
5. 把可运行、可下载或 API 可访问误当成可再分发。
