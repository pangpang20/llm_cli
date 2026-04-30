# LLM CLI Agent

一个类似 Claude Code 的命令行 AI 助手工具。支持多厂商大模型（Qwen、豆包、DeepSeek、Kimi），浏览器扫码登录，自动进化工具箱，在终端中与 AI 对话并自动调用工具完成任务。

## 工作原理

```
终端输入 ──> 认证 Cookie ──> 厂商网页 API ──> AI 回复 ──> 工具执行 ──> 自动进化
```

1. 首次运行自动打开浏览器，扫码登录对应厂商网站
2. 登录成功后提取 Cookie 保存到本地
3. 后续通过 Cookie 调用对应厂商的内部 API，无需 API Key
4. 每次交互的经验自动记录，系统持续进化

## 支持的厂商

| 厂商 | ID | 登录地址 |
|------|-----|----------|
| 通义千问 | `qwen` | chat.qwen.ai |
| 豆包 | `doubao` | doubao.com |
| DeepSeek | `deepseek` | chat.deepseek.com |
| Kimi | `kimi` | kimi.moonshot.cn |

切换厂商：
```bash
LLM_PROVIDER=doubao npm start
LLM_PROVIDER=deepseek npm start
LLM_PROVIDER=kimi npm start
```

## 功能特性

### 核心功能
- **多厂商支持** — Qwen、豆包、DeepSeek、Kimi 一键切换
- **浏览器登录** — 有浏览器环境：打开窗口扫码；无浏览器环境：截图展示二维码
- **交互式 REPL** — 在终端中与 AI 自由对话
- **多轮工具链** — AI 可以连续调用多个工具完成复杂任务
- **会话持久化** — Cookie 保存 12 小时，无需重复登录

### 自动进化 (Harness)
- **记忆系统** — 自动记住成功的模式、失败的原因、用户偏好
- **自我改进** — 工具调用失败时自动分析原因，积累经验规则
- **自动化钩子** — 配置启动/退出/错误时的自动行为

### 工具能力
| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容（限制在项目目录） |
| `write_file` | 创建或覆盖文件（限制在项目目录） |
| `edit_file` | 精确文本替换（限制在项目目录） |
| `bash` | 执行 Shell 命令 |
| `browser_navigate` | 打开指定 URL |
| `browser_screenshot` | 对当前页面截图 |
| `browser_text` | 提取页面文本内容 |
| `browser_click` | 点击页面上的元素 |
| `browser_type` | 在输入框中输入文本 |

## 安装

```bash
# 克隆仓库
git clone git@github.com:pangpang20/llm_cli.git
cd llm_cli

# 安装依赖
npm install

# 编译 TypeScript
npm run build
```

## 使用

### 1. 启动 & 登录

```bash
# 默认使用 Qwen
npm start

# 使用其他厂商
LLM_PROVIDER=doubao npm start
```

首次运行会自动打开浏览器（有显示环境）或展示截图（无显示环境）：
1. 打开对应厂商的登录页面
2. 扫码或输入账号密码登录
3. 登录成功后浏览器自动关闭，认证信息保存到本地

之后 12 小时内再次运行无需登录。

### 2. 无浏览器 Linux 服务器登录

在纯终端的 Linux 服务器上：

```bash
# 方式一：截图模式（程序会打印 base64 截图，需自行解码查看）
NO_SANDBOX=1 npm start

# 方式二：在其他机器登录后复制 session 文件
# 将 .qwen_session.json 拷贝到服务器的项目目录即可
```

### 3. 开始对话

```
=== LLM CLI Agent (Qwen) ===
Type /help for commands. Ctrl+C to exit.

> 帮我创建一个 Hello World 的 Python 脚本
```

AI 会直接调用工具完成任务，无需手动操作。

### 4. 内置命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/clear` | 清空对话历史 |
| `/login` | 重新打开浏览器登录 |
| `/provider` | 列出可用的 AI 厂商 |
| `/memory` | 查看已学习的记忆和经验 |
| `/quit` 或 `/exit` | 退出程序 |

### 5. 会话管理

| 文件 | 说明 |
|------|------|
| `.qwen_session.json` | Qwen 认证 Cookie，12 小时过期 |
| `.doubao_session.json` | 豆包认证 Cookie |
| `.deepseek_session.json` | DeepSeek 认证 Cookie |
| `.kimi_session.json` | Kimi 认证 Cookie |
| `.llm_memory.json` | 自动进化记忆文件 |
| `.llm_rules.json` | 自动学习的规则 |
| `.llm_hooks.json` | 自动化钩子配置 |

```bash
# 强制重新登录
rm .qwen_session.json
npm start

# 查看学习到的经验
# 在对话中输入 /memory
```

### 6. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_PROVIDER` | `qwen` | 选择 AI 厂商（qwen/doubao/deepseek/kimi） |
| `NO_SANDBOX` | `0` | 设为 `1` 时禁用浏览器沙箱（Docker/CI 环境） |

## 开发

```bash
# 监听模式，自动重新编译
npm run dev

# 手动编译
npm run build

# 类型检查
npm run lint
```

## 项目结构

```
src/
  index.ts                - REPL 主循环入口
  providers/
    base.ts               - Provider 基类（通用登录、会话管理）
    qwen.ts               - Qwen 提供商
    doubao.ts             - 豆包提供商
    deepseek.ts           - DeepSeek 提供商
    kimi.ts               - Kimi 提供商
    index.ts              - 提供商注册表
  harness/
    memory.ts             - 记忆系统：经验记录与检索
    self_improve.ts       - 自我改进：自动学习规则
    hooks.ts              - 自动化钩子：启动/退出/错误
    index.ts              - Harness 整合
  tools/
    types.ts              - 工具接口定义
    read.ts               - 文件读取
    write.ts              - 文件写入
    edit.ts               - 文件编辑
    bash.ts               - Shell 命令
    browser.ts            - 浏览器自动化
    index.ts              - 工具注册导出
```
