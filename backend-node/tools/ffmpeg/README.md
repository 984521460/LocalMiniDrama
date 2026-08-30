# FFmpeg 本地目录

此目录仅用于本地开发。Windows 安装包和便携版不会分发这里的二进制；用户需自行取得符合其使用场景许可条件的 FFmpeg。将可执行文件放在此目录后，开发后端会优先使用，**无需配置环境变量**。

## 需要拷贝的文件（Windows）

- `ffmpeg.exe`
- `ffprobe.exe`（若需要探测时长等信息）

FFmpeg 官方下载页会列出源码及第三方平台构建入口。请核验实际提供者、版本、许可证、构建配置和对应源码，不要把“可以下载/运行”误当成“可以随本项目再分发”。

## 一键拷贝（可选）

若你已合规取得本机 FFmpeg，且其 `bin` 目录为 `D:\Program Files\ffmpeg\bin`，可在 **backend-node** 目录下执行：

```bash
node scripts/copy-ffmpeg.js "D:\Program Files\ffmpeg\bin"
```

会复制 `ffmpeg.exe` 和 `ffprobe.exe` 到本目录。

## 路径优先级

1. 本目录下的 `ffmpeg`（或 Windows 下 `ffmpeg.exe`）
2. 环境变量 `FFMPEG_PATH`（若已设置）
3. 系统 PATH 中的 `ffmpeg`

桌面安装后也可把用户自备的 `ffmpeg.exe` 与 `ffprobe.exe` 放入 `%APPDATA%\localminidrama-desktop\backend\tools\ffmpeg\`。项目不会自动从安装包解压或复制 FFmpeg。
