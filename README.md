# ChatGPT Store Links Skill

查询并校验微软官方 ChatGPT Work/Codex Windows MSIX 临时下载直链。

> npm 包与 Skill 名：`chatgpt-store-links-skill`
>
> GitHub：[`MisonL/chatgpt-store-download`](https://github.com/MisonL/chatgpt-store-download)

本项目只负责链接发现和校验，不下载完整 MSIX、不获取许可证、不安装应用，也不修改 Windows 设置。

## 快速开始

需要 Node.js 14+；使用 `npx --yes` 需要 npm 7+。

### 1. 安装 Skill

```sh
npx --yes @mison/chatgpt-store-links-skill
```

默认安装到：

```text
~/.Agents/skills/chatgpt-store-links-skill
```

指定 Codex 技能目录：

```sh
npx --yes @mison/chatgpt-store-links-skill \
  --target "$HOME/.codex/skills/chatgpt-store-links-skill"
```

如果 npm 包暂不可用，可从 GitHub 源安装：

```sh
npx --yes --allow-git=root github:MisonL/chatgpt-store-download
```

如果 npm 版本不支持 Git 源，在已克隆的仓库目录运行 `node bin/install.js`；npm 6 可去掉 `--yes`。安装完成后重新打开 Codex 会话。

### 2. 查询直链

在已安装的 Skill 目录中运行：

```sh
node scripts/fetch_links.js --arch x64 --json
```

常用命令：

```sh
node scripts/fetch_links.js --arch arm64 --json
node scripts/fetch_links.js --arch both --json
node scripts/fetch_links.js --arch x64 --strict-tls --json
node scripts/fetch_links.js --arch both --redact-url --json
node scripts/fetch_links.js --self-test --json
```

`--arch both` 会分别查询 x64 和 arm64；任一架构失败时整体退出码为 1。

## 功能特性

- 查询 Microsoft StoreEdge 产品元数据和 FE3 更新信息。
- 支持 x64、arm64 和 both，不伪装支持 x86。
- 校验产品身份、发布者、PFN、PackageMoniker、版本、大小、SHA-1、SHA-256 和 CDN 响应。
- 校验 HTTPS 主机白名单、重定向、响应大小、Content-Disposition 文件名和有限重试。
- 支持 macOS、Linux、Windows 和 WSL 上的 Node.js，以及 NVM、nvm-windows、Volta、asdf、mise。
- 提供文本、JSON 输出和不访问网络/磁盘的离线自测。
- 提供 `--redact-url`，便于在日志和 CI 中隐藏临时签名参数。

## 参数参考

| 参数 | 说明 |
| --- | --- |
| `--arch x64\|arm64\|both` | 目标 Windows 架构，默认 `x64` |
| `--product-id 9PLM9XGG6VKS` | ChatGPT Work/Codex 产品 ID |
| `--market US` | StoreEdge 市场，默认 `US` |
| `--locale en-us` | StoreEdge 语言，默认 `en-us` |
| `--ring Retail` | FE3 稳定通道，默认 `Retail` |
| `--timeout 45` | 单次请求超时秒数，范围 `1-300` |
| `--json` | 输出机器可读 JSON |
| `--redact-url` | 隐藏输出中的临时签名查询参数，不改变实际请求 |
| `--self-test` | 运行离线自测 |
| `--strict-tls` | 启用 TLS 证书和主机名校验 |
| `--insecure-tls` | 显式使用兼容模式 |
| `--help` | 显示帮助 |

## 输出与安全

默认兼容模式会关闭 TLS 证书校验，以适配证书链不完整的环境；输出始终带有安全警告。需要严格来源认证时，显式添加 `--strict-tls`。

- `url_verified`：StoreEdge/FE3 元数据与 CDN 探针一致，不代表文件已下载。
- `tls_verified`：仅严格 TLS 模式且整体成功时为 `true`。
- `local_hash_verified`：本 Skill 不下载文件，因此始终为 `false`。
- CDN URL 带短时签名，不要长期缓存、公开记录或手工修改，失效后重新查询。

## 平台说明

- Windows CMD 中文异常时先执行 `chcp 65001`；PowerShell 5.1 保存 JSON 时使用 `Out-File -Encoding utf8`。
- macOS/Linux 的 NVM 需要在当前 shell 先加载 `nvm.sh`；非交互任务不要假定 shell 配置已加载。
- WSL 只能运行查询层，不能在 Linux 内安装或启动 MSIX；请将 URL 交给 Windows 侧处理。
- 脚本使用直连 HTTPS，不读取 `HTTP_PROXY` 或 `HTTPS_PROXY`。

## 边界

本 Skill 不获取 Microsoft Store 许可证，不处理 App Installer 依赖，不绕过 MSIX 签名或系统策略。Windows 1809/1909、精简系统、缺失 Store、完全内网、签名、许可证和完整安装行为，必须在目标设备单独验收。

## 验证

```sh
npm test
npm pack --dry-run
```

`npm test` 包含 JavaScript 语法检查、安装器测试和 `fetch_links.js --self-test --json`；离线自测不替代真实 StoreEdge/FE3、CDN、Windows 下载、签名、许可证和安装验收。

## 目录结构

```text
chatgpt-store-links-skill/
|-- README.md
|-- LICENSE
|-- package.json
|-- bin/install.js
|-- test/install.test.js
`-- chatgpt-store-links-skill/
    |-- SKILL.md
    |-- agents/openai.yaml
    `-- scripts/fetch_links.js
```

协议流程、JSON 字段和错误码见 [chatgpt-store-links-skill/SKILL.md](chatgpt-store-links-skill/SKILL.md)。

## 许可证

[MIT License](LICENSE)
