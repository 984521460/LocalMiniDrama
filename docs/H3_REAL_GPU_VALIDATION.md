# MiniMax H3 Phase 7 真实 GPU 验收

本手册用于在已获授权的 RTX 4090 实例上执行 Phase 7 四模式验收。它不负责创建实例、登录、下载模型或调用付费服务，也不得把合成测试或未审核候选冒充真实 GPU 证据。

## 1. 验收范围

一次完整计划固定包含且只包含以下四项，顺序不可变：

1. `t2v`
2. `fl2va-first`
3. `fl2va-first-last`
4. `ref2va`

`ref2va` 验收项必须同时使用 4 张有序参考图和 1 条参考音频，以覆盖多图参考、可选参考音频及 H3 原生音频输出。默认烟雾验收为 `608×352`、24 FPS、39 帧（1625 ms）；已有的 15 秒 T2V 证据保留用于长时长边界。

## 2. 生成验收计划

输入 JSON 必须包含：

- `planUid`：新的规范 UUIDv4；
- `gpuClass`：固定为 `rtx4090-24gb`；标准 RTX 4090 的显存为 24 GiB，实例平台显示值可能因单位和保留显存略低；
- `cases`：四个按上述顺序排列的对象；
- 每个 case 只含 `generationSpec`、`filenamePrefix`、`mediaBindings`；
- T2V 的 `mediaBindings` 必须为 `null`；
- 其他模式的每项媒体绑定只含 `assetVersionUid`、`sha256`、`fileName`，并与规格中的同一 AssetVersion 证据完全一致；
- `fileName` 是 ComfyUI `input/` 下的安全相对文件名，不是本机绝对路径。

运行：

```powershell
cd backend-node
npm run h3:validation -- prepare --input D:\h3-validation\input.json --output D:\h3-validation\plan.json
```

以上示例在 Windows 本地协调端运行；在 Linux 算力实例上使用相同子命令，并把输入、输出和 `localRoot` 改为实例内的绝对 Linux 路径（例如 `/workspace/h3-validation/...`）。

命令拒绝重复 JSON 键、畸形 UTF-8、符号链接输入、超限 JSON 和已存在的输出文件。生成的 `plan.json` 包含完整 Manifest、归一化生成规格、媒体绑定、可提交的 Comfy prompt、输出节点、预期媒体参数及整体 SHA-256。

可在传输前或实例上复验：

```powershell
npm run h3:validation -- check --input D:\h3-validation\plan.json --output D:\h3-validation\checked-plan.json
```

## 3. 在实例上执行

执行前必须完成以下人工核对：

- 当前实例确为获批的 RTX 4090 档位；
- ComfyUI 只监听回环地址或受控隧道；
- Manifest 要求的节点和模型全部存在；
- 本地模型文件名与计划一致，真实 SHA-256 已另行核验；
- 每个参考媒体复制到对应 `fileName` 前后都与计划中的 SHA-256 一致；
- 不向计划、日志、收据或 prompt 写入密码、Token、SSH 私钥或绝对私人路径。

对每个 case，将 `case.prompt` 作为 ComfyUI API prompt 提交。保存独立的 `prompt_id`、输出 MP4 相对路径、远端 SHA-256 和字节数。四项不得复用 `prompt_id`、输出 AssetVersion UID 或输出文件哈希。

## 4. 封装单项收据

收据输入 JSON 的固定结构为：

```json
{
  "localRoot": "D:\\h3-validation\\outputs",
  "ffprobePath": "ffprobe",
  "ffmpegPath": "ffmpeg",
  "timeoutMs": 60000,
  "environment": {},
  "receipt": {
    "receiptUid": "00000000-0000-4000-8000-000000000000",
    "gpuClass": "rtx4090-24gb",
    "promptId": "00000000-0000-4000-8000-000000000000",
    "manifest": {},
    "generationSpec": {},
    "assetVersionUid": "00000000-0000-4000-8000-000000000000",
    "localRelativePath": "mode/output.mp4",
    "remoteSha256": "64位小写十六进制",
    "remoteBytes": 1
  }
}
```

其中 `environment` 必须是完整的脱敏环境证据，并精确包含已核验的 GPU、运行时与全部七个模型摘要；`manifest` 和 `generationSpec` 必须原样取自对应 plan case。示例零 UUID、空对象和占位值不可用于真实收据。

运行：

```powershell
npm run h3:validation -- receipt --input D:\h3-validation\receipt-input.json --output D:\h3-validation\receipt.json
```

采集器会重新计算本地文件 SHA-256 和字节数，并调用 FFprobe/FFmpeg 验证 MP4、H.264、AAC、尺寸、24 FPS、帧数、时长、黑帧和冻结帧阈值。任何不一致都只返回固定失败，不生成收据。

## 5. 汇总门禁

把脱敏环境对象和四个收据组成 `{ "environment": {...}, "receipts": [...] }` 后运行：

```powershell
npm run h3:validation -- gate --input D:\h3-validation\receipts.json --output D:\h3-validation\gate.json
```

固定候选工作流可以生成“待审核实测收据”，但不会自动变成可信生产工作流。首次真实运行后仍需：

1. 人工观看四个视频，确认运动、首尾帧约束、参考角色一致性、音画同步和镜头可用性；
2. 复核模型摘要、GPU 来源和 ComfyUI/节点版本；
3. 将通过审核的精确 Manifest 与收据作为一次独立代码变更纳入可信清单；
4. 重新执行门禁。只有 `evidenceComplete=true` 才能封账 Phase 7 并进入 Phase 8。

当前版本中，`prepared-unverified` 仍表示尚未执行的计划；未经过本轮实测的其他 Ref2VA 组合继续保留 `implementation-candidate-unverified`。本轮精确四个变体完成审核后，门禁的 `workflowUnavailableModes` 为空。

## 6. 2026-08-29 RTX 4090 封账证据

本轮在标准 RTX 4090 24 GiB 实例上完成四个模式的独立生成。四份收据位于 `evidence/h3/phase7/receipt-*.json`，脱敏运行环境位于 `evidence/h3/phase7/environment.json`，聚合输入与机械门禁分别位于 `evidence/h3/phase7/receipts.json` 和 `evidence/h3/phase7/gate.json`。

四个输出均为 `608×352`、24 FPS、39 帧、1625 ms、H.264 视频与单路 AAC 音频；黑帧率与冻结帧率均为 0。每个模式使用独立的 prompt ID、AssetVersion UID 与输出 SHA-256。抽帧检查确认人物运动、镜头连续性和参考主体一致性，未发现黑屏或冻结；本轮没有人工听审音画同步，因此只记录 AAC 音轨技术存在，不把音画同步列为已人工验收。

机械门禁结果为 `evidenceComplete=true`，`profileRevision=2`，`profileSha256=78fb9d7f8c75c324f73d2bb0297a8dfce021e48f3de4239506ba6c22583ffc35`，`environmentSha256=541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8`，`receiptsSha256=2c7dc35728c7fcff7a46fba972bd8a12c8a94333b22e87806d83e6f64460d839`。受信范围严格限定为：T2V、1 张首帧 FL2VA、首尾各 1 张 FL2VA、4 张参考图加参考音频 Ref2VA。其他 Ref2VA 组合和 RTX PRO 6000 Blackwell 实测仍未完成；生产编译入口也不会因本次证据更新而自动扩展，留待 Phase 8 单独接线与验收。
