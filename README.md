# LLM CLI Agent

一个类似 Claude Code 的命令行 AI 助手工具。在终端中与大语言模型对话，AI 可以自动调用工具完成文件读写、Shell 命令执行、浏览器操作等任务。

## 功能特性

- **交互式 REPL** — 在终端中与 AI 自由对话
- **文件操作** — 读取、创建、编辑文件
- **Shell 命令** — 执行任意终端命令
- **浏览器自动化** — 打开网页、截图、提取文本、点击、输入
- **多轮工具链** — AI 可以连续调用多个工具完成复杂任务
- **OpenAI 兼容接口** — 支持 DashScope（通义千问）及其他兼容 API

## 工具列表

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容 |
| `write_file` | 创建或覆盖文件 |
| `edit_file` | 精确文本替换 |
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

### 1. 配置 API Key

目前默认使用 [DashScope API](https://dashscope.console.aliyun.com/)（通义千问），需要在阿里云获取 API Key：

```bash
export DASHSCOPE_API_KEY=your-api-key-here
```

### 2. 启动

```bash
npm start
```

进入交互界面后直接输入问题或指令即可：

```
=== LLM CLI Agent ===
Type /help for commands. Ctrl+C to exit.

> 帮我创建一个 Hello World 的 Python 脚本
```

AI 会自动调用 `write_file` 工具创建文件。

### 3. 内置命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/clear` | 清空对话历史 |
| `/quit` 或 `/exit` | 退出程序 |

### 4. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DASHSCOPE_API_KEY` | 必需 | API 密钥 |
| `LLM_MODEL` | `qwen-plus` | 使用的模型名称 |
| `LLM_BASE_URL` | DashScope 默认地址 | 自定义 API 地址（OpenAI 兼容接口） |

### 兼容其他 API

如果你想使用其他兼容 OpenAI 接口的 API（如 OpenAI、本地 Ollama 等）：

```bash
export DASHSCOPE_API_KEY=your-key
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_MODEL=gpt-4o
npm start
```

## 开发

```bash
# 监听模式，自动重新编译
npm run dev

# 手动编译
npm run build
```

## 项目结构

```
src/
  index.ts              - REPL 主循环入口
  chat.ts               - 对话历史管理
  provider/dashscope.ts - LLM API 封装（OpenAI SDK）
  tools/
    types.ts            - 工具接口定义
    read.ts             - 文件读取工具
    write.ts            - 文件写入工具
    edit.ts             - 文件编辑工具
    bash.ts             - Shell 命令工具
    browser.ts          - 浏览器自动化工具集
    index.ts            - 工具注册导出
```
