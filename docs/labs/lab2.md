# 实验二：ADT 与 OOP 设计与扩展

> 实验目标：以"框架使用者"身份扩展一个新的 Model Provider，体验面向接口编程与开闭原则；设计并实现 `SessionContext` ADT，用封装与防御性编程取代裸露的消息列表。

## 背景

CogmAIt 的 `app/providers/` 目录提供了一个"可插拔式"的模型接入架构雏形：任何新的 LLM 服务商只需继承 `ModelProvider` 并实现其抽象方法，系统即可自动识别并调用。

然而，系统的消息上下文构造部分（尤其是智能体聊天主链路）大量使用裸露的列表和字典在各函数间传递。这类无封装的数据结构极易被沿途代码意外修改，引发难以追踪的状态污染。

---

## 一、OOP 扩展：新增 Model Provider

### 研读基类契约

`app/providers/base.py` 中定义了抽象基类 `ModelProvider`，继承自 Python 标准库的 `ABC`（Abstract Base Class）。`ABC` 机制的作用是：凡被 `@abstractmethod` 标记的方法，子类若未全部实现，Python 解释器将拒绝实例化该子类——这就是"契约"的强制性所在。

`ModelProvider` 的契约分为两个部分：

**一、身份属性（7项，均以 `@property` + `@abstractmethod` 声明）**

| 属性名 | 返回类型 | 用途 |
|--------|----------|------|
| `provider_id` | `str` | 系统内唯一标识符，如 `"deepseek"` |
| `provider_name` | `str` | 前端显示名称 |
| `description` | `str` | 描述文字 |
| `icon` | `Optional[str]` | 图标 URL，无则返回 `None` |
| `default_base_url` | `Optional[str]` | 默认 API 地址 |
| `supported_model_types` | `List[str]` | 如 `["chat", "embedding"]` |
| `features` | `List[str]` | 如 `["streaming"]` |

这些属性由基类已实现的 `to_provider_info()` 方法统一打包为字典，供 `manager.py` 扫描目录后向前端返回 Provider 列表，无需子类额外处理。

**二、能力方法（4项，均为 `async`）**

- `test_connection(api_key, base_url)`：测试 API Key 与服务端的连通性，用户点击"测试连接"时触发。
- `chat_completion(api_key, messages, model, temperature, max_tokens, base_url, stream, **kwargs)`：发送多轮对话请求。`stream=True` 时须返回 `AsyncGenerator` 实现流式输出。
- `text_completion(api_key, prompt, model, ...)`：单轮文本补全，只传一个字符串 `prompt`，比 `chat_completion` 更简单。
- `embedding(api_key, text, model, ...)`：将文本转为向量，供知识库检索使用。

综上，新建一个 Provider 时，必须实现上述共 11 项（7 个属性 + 4 个方法），缺少任何一项均无法实例化。

### 实现 DeepSeekProvider

DeepSeek 的 API **完全兼容 OpenAI 协议**，因此只需以已有的 `custom_provider.py` 为模板，修改 4 个身份属性即可，核心的 HTTP 请求逻辑无需改动。

新建文件 `app/providers/deepseek_provider.py`，关键实现如下：

```python
from app.providers.base import ModelProvider

class DeepSeekProvider(ModelProvider):

    @property
    def provider_id(self) -> str:
        return "deepseek"          # manager 用此值作字典 key

    @property
    def provider_name(self) -> str:
        return "DeepSeek"

    @property
    def description(self) -> str:
        return "DeepSeek 大模型服务，支持 deepseek-chat 等系列模型"

    @property
    def default_base_url(self) -> Optional[str]:
        return "https://api.deepseek.com/v1"   # 官方 API 地址

    @property
    def supported_model_types(self) -> List[str]:
        return ["chat", "completion", "embedding"]

    @property
    def features(self) -> List[str]:
        return ["streaming", "function_calling"]

    @property
    def icon(self) -> Optional[str]:
        return None
```

`chat_completion` 的流式实现使用 `httpx` 的 `client.stream()` 接口，对 SSE 格式（`data: {...}\n\n`）进行逐行解析，直到收到 `[DONE]` 信号为止：

```python
async def chat_completion(self, api_key, messages, model,
                          stream=False, **kwargs):
    url = base_url or self.default_base_url
    data = {"model": model, "messages": messages, "stream": stream}

    if stream:
        async def stream_generator():
            async with httpx.AsyncClient() as client:
                async with client.stream("POST",
                        f"{url}/chat/completions",
                        headers={"Authorization": f"Bearer {api_key}"},
                        json=data) as response:
                    buffer = ""
                    async for chunk in response.aiter_text():
                        buffer += chunk
                        while "\n\n" in buffer:
                            event, buffer = buffer.split("\n\n", 1)
                            for line in event.split("\n"):
                                if line.startswith("data: "):
                                    data_str = line[6:]
                                    if data_str.strip() == "[DONE]":
                                        continue
                                    yield json.loads(data_str)
        return stream_generator()
    # 非流式：直接 POST，等待完整 JSON 响应
```

### 自动发现机制

`manager.py` 的 `_load_providers()` 使用 `pkgutil.iter_modules()` 扫描 `providers/` 目录，再用 `inspect.getmembers()` 找出所有继承了 `ModelProvider` 的类并自动实例化。文件保存后无需修改任何其他代码，服务器重启日志即出现：

```
已加载提供商: DeepSeek (deepseek)
```

此外，`manager.py` 内置了 watchdog 文件监控，支持热重载——文件保存即生效，无需重启服务器。

端到端验证：通过 REST API 依次创建模型配置、创建智能体，最后发送流式对话请求，DeepSeek 以 SSE 格式逐字返回，最终收到 `finish_reason: stop`，验证通过。

### 反思：OCP 与 if-else 的关系

整个扩展过程中，**只新建了一个文件**（`deepseek_provider.py`），未修改 `agents.py`、`manager.py` 或任何其他已有文件。这正是**开闭原则（OCP）**的体现：系统对扩展开放，对修改关闭。

假设 manager 不使用反射自动发现，而是写死 if-else：

```python
if provider == "openai":
    result = openai_provider.chat_completion(...)
elif provider == "deepseek":        # 每次新增都要改这里
    result = deepseek_provider.chat_completion(...)
elif provider == "gemini":          # 又要改
    ...
```

每新增一个 Provider 都需要修改 `agents.py`，违反了开闭原则，也同时违反了单一职责原则（agents.py 承担了本不属于它的分发逻辑）。反射 + 多态的设计让调用方只依赖抽象接口 `ModelProvider`，对具体实现一无所知，彻底消除了这类 if-else。

---

## 二、ADT 设计：SessionContext

### 设计动机

在 `agents.py` 的聊天主链路中，消息上下文以普通列表形式在各函数间传递：

```python
final_messages = []
final_messages.append({"role": "system", "content": system_prompt})
# 各处随意 append，无任何校验
final_messages.append({"role": "hacker", "content": "注入！"})  # 不会报错
final_messages[0]["role"] = "evil"                              # 随意篡改
```

任何中间环节都可以随意修改这个列表，且错误的 `role` 值不会被立即发现。

### AF 与 RI 声明

`SessionContext` 的抽象函数（AF）与表示不变量（RI）如下：

```python
class SessionContext:
    """
    AF: _messages 代表一次智能体对话的完整消息历史，
        按时间顺序排列，每条消息包含发言者身份（role）
        和消息内容（content）。

    RI:
      - 每条消息必须同时包含 'role' 和 'content' 字段
      - role 的值只能是 'user'、'assistant' 或 'system' 之一
      - _messages 的长度不超过 100 条
    """
```

### 防御性编程实现

```python
import copy

class SessionContext:
    VALID_ROLES = {"assistant", "user", "system"}
    MAX_MESSAGES = 100

    def __init__(self, initial_messages=None):
        self._messages = []
        if initial_messages:
            for msg in initial_messages:
                self.add_message(msg)   # 通过统一入口校验，而非直接 append
        self._check_rep()

    def add_message(self, message: dict):
        if "role" not in message or "content" not in message:
            raise ValueError
        if message["role"] not in self.VALID_ROLES:
            raise ValueError
        if len(self._messages) >= self.MAX_MESSAGES:
            raise ValueError
        self._messages.append(copy.deepcopy(message))
        self._check_rep()

    def get_messages(self):
        return copy.deepcopy(self._messages)   # 深拷贝防止外部篡改内部状态

    def _check_rep(self):
        assert len(self._messages) <= self.MAX_MESSAGES
        for msg in self._messages:
            assert "role" in msg
            assert "content" in msg
            assert msg["role"] in self.VALID_ROLES
```

**为什么用 `copy.deepcopy`？** 防止调用方拿到引用后修改内部状态，破坏封装性。

### 接入真实流程

改造 `agents.py` 中 `response_generator` 函数内的消息列表构造逻辑，改动涉及四类操作：

```python
# --- before ---
final_messages = []
final_messages.insert(0, file_context_message)      # 插到最前
final_messages.append({"role": "system",
                        "content": agent.system_prompt})
final_messages.append({"role": msg.role,
                        "content": msg.content})
"messages": final_messages,                         # 传给模型

# --- after ---
ctx = SessionContext()
ctx.prepend_message(file_context_message)           # 插到最前
ctx.add_message({"role": "system",
                  "content": agent.system_prompt})  # 含校验
ctx.add_message({"role": msg.role,
                  "content": msg.content})          # 含校验
"messages": ctx.get_messages(),                     # 返回深拷贝
```

改造完成后用 `grep -n "final_messages" agents.py | grep -v "#"` 确认所有未注释的引用已清零，并再次运行流式对话请求验证端到端链路正常。

**测试反哺设计：** 破坏性测试驱动出了一处接口遗漏——原始 `SessionContext` 只有 `add_message`（末尾追加），接入 `agents.py` 时发现 `insert(0, ...)` 无法映射到任何已有方法，于是补充了 `prepend_message`（头部插入）。

### 破坏性单元测试

针对 `SessionContext` 的防御屏障，编写了 4 个破坏性测试，覆盖全部 RI 约束。运行结果：`4 passed in 0.01s`，所有防御均有效。

```python
import pytest
from app.utils.session_context import SessionContext

def test_invalid_role_is_rejected():
    ctx = SessionContext()
    with pytest.raises(ValueError):
        ctx.add_message({"role": "hacker", "content": "insert"})

def test_missing_field_is_rejected():
    ctx = SessionContext()
    with pytest.raises(ValueError):
        ctx.add_message({"role": "user"})

def test_get_messages_returns_copy():
    ctx = SessionContext()
    ctx.add_message({"role": "user", "content": "test"})
    msgs = ctx.get_messages()
    msgs.append({"role": "user", "content": "injected"})
    assert len(ctx.get_messages()) == 1   # 内部仍只有 1 条

def test_max_messages_limit():
    ctx = SessionContext()
    with pytest.raises(ValueError):
        for i in range(101):
            ctx.add_message({"role": "user",
                             "content": f"this is the {i}th"})
```

---

## 总结

| 维度 | 收获 |
|------|------|
| 面向接口编程 | 新增 DeepSeek Provider 只创建一个文件，未触碰任何已有代码；反射 + 多态彻底消除 if-else |
| ADT 防御价值 | SessionContext 将"数据合法"责任从散落各处的调用方，集中到一个类 |
| 测试驱动设计 | 破坏性测试发现接口遗漏（`prepend_message`），补全了 ADT 契约 |

---

## 附录：调试记录

### 问题一：`magic_pdf` 导入导致服务器启动崩溃

**现象：** 启动时报 `ModuleNotFoundError: No module named 'magic_pdf'`，进程直接退出。

**根因：** `app/utils/file_processor.py` 在模块顶层直接 `import magic_pdf`，该包未安装，Python 加载模块时立即崩溃。

**解决：** 改为惰性导入：

```python
try:
    from magic_pdf.data.data_reader_writer import FileBasedDataWriter
    MAGIC_PDF_AVAILABLE = True
except ImportError:
    MAGIC_PDF_AVAILABLE = False
```

后续调用处先检查 `MAGIC_PDF_AVAILABLE`，未安装时优雅降级。

### 问题二：`bcrypt`/`passlib` 版本不兼容导致登录 500

**现象：** `POST /api/auth/login` 返回 500，日志报 `AttributeError: module 'bcrypt' has no attribute '__about__'`。

**根因：** `passlib` 通过读取 `bcrypt.__about__.__version__` 判断版本号，但 bcrypt 4.x 移除了 `__about__` 模块。

**解决：** `pyproject.toml` 中锁定兼容范围：`bcrypt>=3.2.0,<4.0`，然后 `poetry lock && poetry install`。

### 问题三：系统代理拦截本地请求导致 502

**现象：** curl 请求 `localhost:8000` 返回 502 Bad Gateway。

**根因：** 系统配置了 `http_proxy=http://127.0.0.1:7890`（Clash 代理），curl 将本地请求也转发给代理，代理无法连接本地服务。

**解决：** 所有访问本地服务的 curl 命令加 `--noproxy localhost`：

```bash
curl --noproxy localhost http://localhost:8000/api/...
```

### 问题四：对话接口返回 500（非流式分支缺失）

**现象：** `POST /api/agents/{id}/chat` 返回 500。

**根因：** 代码只实现了 `if chat_request.stream:` 分支，非流式模式没有对应的 `else`，函数执行到末尾隐式返回 `None`，FastAPI 无法序列化，触发 500。

**解决：** 发请求时显式传入 `"stream": true`，使用已实现的流式分支。

### 问题五：DeepSeek API 返回 400（模型名称字段含义歧义）

**现象：** 流式响应中出现 `{'status': 'error', 'message': 'API 返回错误: 400'}`。

**根因：** 传给 DeepSeek API 的 `model` 参数直接取自 `model.name`（数据库里存储的显示名 `"DeepSeek Chat"`）。DeepSeek API 要求官方模型标识符（如 `deepseek-chat`），无法识别自定义显示名。

**解决：** 通过 `PUT /api/models/{id}` 将 `name` 字段更新为真实的 API 模型 ID `deepseek-chat`。

**设计启示：** 该系统的 `name` 字段身兼两职——既作显示名，又直接作为 API 调用的 `model` 参数。这是一处隐蔽的耦合，创建模型时 `name` 必须填写 provider 规定的官方模型 ID，而非任意可读名称。
