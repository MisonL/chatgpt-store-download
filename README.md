# ChatGPT Store Download

用于发现并校验微软官方 ChatGPT Work/Codex Windows MSIX 临时下载直链的 Codex Skill。

本项目只负责查询层: 通过 Microsoft StoreEdge 和 FE3 获取目标架构的临时 URL, 校验产品身份、包元数据、摘要、大小和 CDN 响应。它不会下载完整 MSIX, 获取 Microsoft Store 许可证, 安装应用或修改 Windows 设置。

## 快速开始

### 安装 Skill

需要 Node.js 14 或更高版本。使用 `npx --yes` 时还需要 npm 7 或更高版本。安装器默认写入当前用户的 `.Agents/skills/chatgpt-store-download`。

如果 npm registry 已发布此包:

```sh
npx --yes @misonl/chatgpt-store-download
```

如果包名尚未发布到 npm, 可使用 GitHub 源:

```sh
npx --yes github:MisonL/chatgpt-store-download
```

npm 12 默认可能禁止 Git 包。出现 `EALLOWGIT` 时, 使用只允许顶层 Git 包的选项:

```sh
npx --yes --allow-git=root github:MisonL/chatgpt-store-download
```

npm 6 不识别 `--yes`; 可去掉该选项并在提示时确认, 或直接使用 `node bin/install.js`。如果当前 npm 版本不支持 Git 源, 请改用已克隆仓库中的本地安装命令。

如果 npm 或 GitHub 网络不可用, 在仓库目录执行:

```sh
node bin/install.js
```

安装器只复制 Skill 文件, 不下载 ChatGPT MSIX。若 Codex 没有扫描 `.Agents/skills`, 请指定实际技能目录, 例如:

```sh
npx --yes @misonl/chatgpt-store-download --target "$HOME/.codex/skills/chatgpt-store-download"
```

安装完成后, 如果 Codex 已经加载旧版本, 请重新打开会话。

### 查询直链

在安装后的 Skill 目录中执行:

```sh
node scripts/fetch_links.js --arch x64 --json
```

常用命令:

```sh
node scripts/fetch_links.js --arch arm64 --json
node scripts/fetch_links.js --arch both --json
node scripts/fetch_links.js --self-test --json
node scripts/fetch_links.js --arch x64 --strict-tls --json
```

`--arch both` 会分别查询 x64 和 arm64。任一架构失败时整体退出码为 1, 不会用另一架构的 URL 代替失败结果。

## 功能

- 查询 Microsoft StoreEdge 产品元数据和 FE3 更新信息。
- 支持 x64, arm64 和 both; 不伪装支持 x86。
- 校验产品 ID, 发布者, Package Family Name, PackageMoniker, 更新关联, 文件大小, SHA-1, SHA-256 和 CDN 探针。
- 校验 HTTPS 主机白名单, 重定向次数, 响应体上限, Content-Disposition 文件名和可恢复错误重试。
- 默认兼容模式关闭 TLS 证书校验并明确警告; `--strict-tls` 可启用严格校验。
- 支持 macOS, Linux, Windows 和 WSL 上的 Node.js; 兼容 NVM、nvm-windows、Volta、asdf、mise 等运行时管理器。
- 提供文本输出、JSON 输出和不访问网络/磁盘的离线回归自测。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--arch x64\|arm64\|both` | 目标 Windows 架构, 默认 `x64` |
| `--product-id 9PLM9XGG6VKS` | 固定的 ChatGPT Work/Codex 产品 ID |
| `--market US` | StoreEdge 市场, 默认 `US` |
| `--locale en-us` | StoreEdge 语言, 默认 `en-us` |
| `--ring Retail` | FE3 稳定通道, 默认 `Retail` |
| `--timeout 45` | 单次请求超时秒数, 范围 `1-300` |
| `--json` | 输出机器可读 JSON |
| `--self-test` | 运行离线自测, 不访问网络或磁盘 |
| `--strict-tls` | 启用 TLS 证书和主机名校验 |
| `--insecure-tls` | 显式使用默认兼容模式 |
| `--help` | 显示命令帮助 |

## 输出字段如何理解

| 字段 | 含义 |
| --- | --- |
| `ok` | 所有请求架构都完成身份、元数据、URL 和 CDN 探针校验 |
| `url_verified` | StoreEdge/FE3 元数据与 CDN 探针一致, 不代表已下载完整文件 |
| `tls_verified` | 仅严格 TLS 模式且整体成功时为 `true` |
| `local_hash_verified` | 本 Skill 不下载文件, 因此始终为 `false` |
| `security_warning` | 默认兼容模式的证书校验警告 |
| `errors` | 失败阶段、错误码、架构、HTTP 状态和下一步建议 |

输出中的 CDN URL 带有短时签名。不要长期缓存、公开日志记录或手工修改; 失效后重新运行查询。

## 跨平台和编码说明

- Node.js 必须为 14 或更高版本; 建议使用仍受支持的 LTS 版本。
- macOS/Linux 使用系统 Node.js 或先在当前 shell 初始化 NVM。非交互任务不能假定 `.bashrc` 或 `.zshrc` 已加载。
- Windows CMD 如果中文显示异常, 先执行 `chcp 65001`。PowerShell 5.1 保存 JSON 时使用 `Out-File -Encoding utf8`。
- WSL 只能运行查询层, 不能在 Linux 内部署或启动 MSIX。请把 URL 交给 Windows 侧下载和安装; WSL 与 Windows 的 Node.js、证书库和技能目录相互独立。
- WSL、SSH、服务或计划任务可能缺少 `WSL_*` 环境变量; 脚本会尝试从 Linux 内核标记回退识别 WSL。
- 脚本使用直连 HTTPS, 不读取 `HTTP_PROXY` 或 `HTTPS_PROXY`。必须通过代理访问微软服务的环境可能无法连通。

## 安全边界和安装边界

- 仅访问 Microsoft StoreEdge、FE3 和微软 CDN 白名单主机, 不使用第三方镜像。
- 默认兼容模式跳过 TLS 证书校验, 只适合兼容性诊断; 来源认证应使用 `--strict-tls` 并确认 `tls_verified: true`。
- 本 Skill 不获取许可证, 不登录 Microsoft Store, 不处理 App Installer 依赖, 不绕过 MSIX 签名或系统策略。
- Windows 1809/1909、精简系统、缺失 Microsoft Store 组件、完全内网、签名、许可证和完整安装行为都必须在目标设备单独验收。
- WSL 或 macOS/Linux 上查到 URL, 不等于目标 Windows 可以安装或运行 ChatGPT。

## 排障

1. `node` 不存在: 在同一终端检查 `node --version`; 先初始化 NVM 或其他版本管理器, 不要因为非登录 shell 找不到 `node` 就重复安装。
2. 严格 TLS 失败: 检查系统时间、根证书、企业 TLS 检查链和 `NODE_EXTRA_CA_CERTS`; 需要兼容性诊断时可使用默认模式, 但必须保留安全警告。
3. CDN 返回 403、408、429 或 5xx: 临时签名或网络出口可能发生变化; 脚本会有限重试, 仍失败时重新运行, 不要复用旧 URL。
4. 目标 Windows 安装失败: 另行收集 Windows build、包清单、签名、依赖、许可证和 AppX 部署错误。本 Skill 只负责 URL 发现和校验。

## 验证

在仓库根目录执行:

```sh
npm test
npm pack --dry-run --json
```

`npm test` 包含所有 JavaScript 语法检查、安装器测试和 `fetch_links.js --self-test --json`。当前离线自测为 22 项, 不替代真实 StoreEdge/FE3、CDN、Windows 下载、签名、许可证和安装验收。

## 目录结构

```text
chatgpt-store-download/
|-- README.md
|-- LICENSE
|-- .gitattributes
|-- .gitignore
|-- package.json
|-- bin/install.js
|-- test/install.test.js
`-- chatgpt-store-download/
    |-- SKILL.md
    |-- agents/openai.yaml
    `-- scripts/fetch_links.js
```

更完整的协议流程、JSON 字段、错误码和未覆盖边界见 [chatgpt-store-download/SKILL.md](chatgpt-store-download/SKILL.md)。

## 许可证

[MIT License](LICENSE)
