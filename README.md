# ChatGPT Store Download

用于发现并校验微软官方 ChatGPT Work/Codex Windows MSIX 临时下载直链的 Codex Skill。

本仓库中的 Skill 面向需要在不依赖 Microsoft Store 界面的环境中查询官方安装包信息的场景。它可以在 macOS、Linux、Windows 和 WSL 上运行，目标产物始终是 Windows MSIX。

## 能力范围

- 通过 Microsoft StoreEdge 和 FE3 查询 ChatGPT Work/Codex 产品信息。
- 按 `x64`、`arm64` 或两种架构筛选最新包。
- 校验产品身份、PackageFamilyName、包版本、文件大小、SHA-1、SHA-256、更新关联和微软 CDN 响应。
- 输出文本或机器可读 JSON，便于人工查看和自动化调用。
- 提供不访问网络、不写入磁盘的离线回归自测。
- 识别 macOS、Linux、Windows、WSL 以及常见 Node.js 版本管理器的运行环境。

## 明确边界

本 Skill 只负责查询和校验临时直链，不负责：

- 下载完整 MSIX 文件；
- 安装或启动 ChatGPT；
- 获取 Microsoft Store 许可证；
- 修复 Windows 系统组件、依赖、UAC 或 Microsoft Store；
- 保证 Windows 1809、1909、精简系统或完全内网环境能够安装和登录。

默认兼容模式会跳过 TLS 证书校验，以适配缺少 Microsoft Update 根证书的环境。结果会明确标记 `tls_verified: false` 并附带安全警告；需要来源认证时使用 `--strict-tls`，且只有全部请求成功时才会标记为已验证。

直链包含短时签名，应按临时敏感凭据处理，不要写入公开日志、长期缓存或转发给无关人员。直链失效后应重新查询，不要手工拼接或使用第三方镜像。

## 仓库结构

```text
chatgpt-store-download/
├── README.md
├── .gitattributes
├── .gitignore
└── chatgpt-store-download/
    ├── SKILL.md
    ├── agents/
    │   └── openai.yaml
    └── scripts/
        └── fetch_links.js
```

`chatgpt-store-download/SKILL.md` 是 Skill 入口；`agents/openai.yaml` 提供 Codex 界面元数据；`scripts/fetch_links.js` 是仅使用 Node.js 标准库的查询脚本。

## 运行要求

- Node.js 14 或更高版本，推荐使用当前受支持的 LTS 版本。
- 不需要 npm 包，也不需要执行 `npm install`。
- Windows CMD 若中文显示异常，可先执行 `chcp 65001`。
- Linux/macOS 使用 NVM、Volta、asdf、mise、nodenv、fnm、nvs 等版本管理器时，必须先在当前 shell 中初始化，使 `node --version` 可用。
- WSL 只能执行查询层；查询得到的 Windows MSIX 直链必须交给 Windows 侧下载和安装。

跨平台启动、NVM 非交互 shell、PowerShell 编码和 WSL 注意事项详见 [Skill 说明](chatgpt-store-download/SKILL.md)。

## 快速开始

在仓库根目录执行：

```sh
# 查询 x64 包并输出文本
node chatgpt-store-download/scripts/fetch_links.js --arch x64

# 查询 x64 包并输出 JSON
node chatgpt-store-download/scripts/fetch_links.js --arch x64 --json

# 同时查询 x64 和 ARM64
node chatgpt-store-download/scripts/fetch_links.js --arch both --json

# 启用严格 TLS 证书校验
node chatgpt-store-download/scripts/fetch_links.js --arch x64 --strict-tls --json

# 执行离线自测
node chatgpt-store-download/scripts/fetch_links.js --self-test --json
```

Windows PowerShell 可使用：

```powershell
node .\chatgpt-store-download\scripts\fetch_links.js --arch x64 --json
```

Windows CMD 可使用：

```bat
chcp 65001 >NUL
node chatgpt-store-download\scripts\fetch_links.js --arch x64 --json
```

## 参数摘要

| 参数 | 说明 |
| --- | --- |
| `--arch x64\|arm64\|both` | 目标 Windows 架构，默认 `x64` |
| `--json` | 输出机器可读 JSON |
| `--self-test` | 执行离线回归自测，不访问网络、不写入磁盘 |
| `--strict-tls` | 启用 TLS 证书和主机名校验 |
| `--insecure-tls` | 显式使用兼容模式跳过 TLS 校验；也是默认模式 |
| `--market US` | StoreEdge 市场，默认 `US` |
| `--locale en-us` | StoreEdge 语言，默认 `en-us` |
| `--ring Retail` | FE3 稳定通道，默认 `Retail` |
| `--timeout 45` | 单次请求超时秒数，范围 `1-300` |
| `--help` | 显示完整帮助 |

产品 ID 固定为 ChatGPT Work/Codex 的 `9PLM9XGG6VKS`，不支持通过参数切换到其他产品。

## 输出和失败处理

成功结果包含产品元数据、运行环境、架构包信息、临时 URL、版本、大小、摘要、探针方式和验证范围。`url_verified` 仅表示 StoreEdge/FE3 元数据与 CDN 探针一致，不代表完整文件已下载，也不代表 TLS 或 Microsoft Store 许可证已验证。

失败时进程退出码为 `1`，JSON 会包含 `error_code`、`message`、`stage`、`retryable` 和 `next_action`。`--arch both` 允许分别报告两个架构的结果，但任一架构失败时整体仍返回失败。

常见的 CDN `403` 可能表示临时签名过期或网络出口策略限制。应重新运行脚本获取新 URL，并保留错误阶段、HTTP 状态和重试次数；不要使用另一架构或旧地址替代失败结果。

## 验证与开发

脚本修改后至少执行：

```sh
node --check chatgpt-store-download/scripts/fetch_links.js
node chatgpt-store-download/scripts/fetch_links.js --self-test --json
```

自测当前覆盖 19 项解析、参数、TLS 状态、文件名、CDN 探针、摘要、重试和运行环境诊断检查。它不替代真实微软接口、CDN、Windows 安装、许可证或目标系统验收。

仓库文件统一使用 UTF-8、无 BOM 和 LF 换行；`.gitattributes` 用于在不同平台上保持该约束。

## 作为 Codex Skill 使用

将仓库中的 `chatgpt-store-download/` 目录安装到 Codex 的 Skill 目录后，可通过 `$chatgpt-store-download` 调用。使用前应重新查询实时 StoreEdge/FE3 元数据；历史版本号、旧 JSON 或旧签名 URL 不能代替当前查询。

## 许可证

本仓库采用 [MIT License](LICENSE)。
