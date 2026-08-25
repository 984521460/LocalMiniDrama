# 工程基线命令

本文档定义 Phase 0 之后本项目在仓库根目录使用的统一工程入口。子项目原有命令仍可用，但 CI、验收和后续实施优先调用这里的根级命令。

## 环境

- Windows PowerShell
- Node.js 22.x
- npm 10.x
- 三个子项目各自保留并使用自己的 `package-lock.json`

根目录 `package.json` 不引入 workspace，也不合并锁文件。这样可以在 Phase 0 保持上游目录和 Electron 打包行为稳定；v2 workspace 是否建立由实施方案 Phase 2 决定。

## 全新环境安装

```powershell
npm run install:all
```

也可以分别安装：

```powershell
npm run install:backend
npm run install:frontend
npm run install:desktop
```

所有安装命令使用 `npm ci`，以当前锁文件为准，不静默改写依赖版本。

## 测试与构建

```powershell
npm test
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm run verify:mvp
npm run verify
```

对应的细分命令：

```powershell
npm run licenses:check
npm run test:backend
npm run test:frontend
npm run build:frontend
```

`npm run verify` 依次检查直接依赖许可证元数据、执行后端测试、前端测试和前端生产构建。它不等于 Electron 运行验收，也不等于完整业务闭环。

`test:unit` 排除文件名后缀为 `.integration.test.js` 和 `.e2e.test.js` 的测试；`test:integration` 当前运行真实内存数据库上的 API 配置合同；`test:e2e` 使用隔离临时目录、临时 SQLite 数据库和真实回环 socket 验证后端健康端点。任何测试层没有文件时都会非零退出，不以空脚本冒充通过。`verify` 是 `verify:mvp` 的兼容别名。

## 数据库

```powershell
npm run migrate
```

迁移使用现有后端命令。执行前应确认目标数据库不是需要保留且没有备份的用户数据库。

## 本地开发

分别在两个终端运行：

```powershell
npm run dev:backend
npm run dev:frontend
```

后端默认地址为 `http://127.0.0.1:5679`，前端开发地址为 `http://127.0.0.1:3013`。

## Windows 打包

```powershell
npm run pack:windows
npm run pack:win
npm run dist:windows
```

- `pack:windows` 生成未安装目录，用于快速启动检查；
- `pack:win` 是实施方案约定的标准别名，当前转发到 `pack:windows`；
- `dist:windows` 生成 NSIS 安装版和便携版；
- 打包前必须先完成 `npm run install:all` 和 `npm run verify`；
- 当前 FFmpeg、示例项目和演示素材仍受 `THIRD_PARTY_NOTICES.md` 的发布阻断条件约束。打包成功不能替代许可证放行。

## 完成证据

每次阶段验收分别记录：

1. 当前 HEAD 和工作树状态；
2. 实际执行的命令与退出状态；
3. 测试、构建、打包和运行结果；
4. 未验证项和剩余风险；
5. stage、commit、push、发布和部署状态。
