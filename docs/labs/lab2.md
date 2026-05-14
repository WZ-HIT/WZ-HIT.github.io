# 实验二：ADT 与 Provider

> 实验目标：新增 DeepSeek Model Provider，设计并实现 SessionContext ADT，完成端到端联调验证。

## 任务一：新增 DeepSeek Provider

### 理解自动发现机制

`app/providers/manager.py` 用 `pkgutil.iter_modules()` 扫描 `providers/` 目录，用 `inspect.getmembers()` 过滤出继承了 `ModelProvider` 的类并自动实例化。

**结论：新建一个 `xxx_provider.py` 文件放到 `app/providers/`，服务器重启后即自动识别，无需修改任何现有文件。** 这正是开闭原则的体现。

### 实现 DeepSeekProvider

DeepSeek API 完全兼容 OpenAI 协议，参考 `custom_provider.py` 实现，只需修改身份属性：

```python
class DeepSeekProvider(ModelProvider):

    @property
    def provider_id(self) -> str:
        return "deepseek"

    @property
    def default_base_url(self) -> Optional[str]:
        return "https://api.deepseek.com/v1"

    async def chat_completion(self, api_key, messages, model, ...):
        # 流式：httpx client.stream() 逐行解析 SSE
        # 非流式：直接 POST 等待完整 JSON
        ...
```

服务器启动日志出现 `已加载提供商: DeepSeek (deepseek)` 说明自动发现成功。

### 踩坑记录

**问题 1：magic_pdf 导入崩溃**

`file_processor.py` 顶层直接 `import magic_pdf`，该包未安装，服务器启动即崩溃。

解决：改为惰性导入，用 `try/except ImportError` 包裹，设置 `MAGIC_PDF_AVAILABLE` 标志位。

**问题 2：bcrypt 版本不兼容 → 登录 500**

`passlib` 读取 `bcrypt.__about__.__version__`，但 bcrypt 4.x 移除了 `__about__` 模块。

解决：`pyproject.toml` 中固定 `bcrypt>=3.2.0,<4.0`。

**问题 3：DeepSeek API 返回 400**

模型 `name` 字段在系统中身兼两职——既是显示名，又是传给 API 的 `model` 参数。创建模型时 `name` 必须填真实的 API 模型 ID（如 `deepseek-chat`），而非随意的显示名。

## 任务二：设计 SessionContext ADT

### 什么是 ADT

ADT（Abstract Data Type，抽象数据类型）把数据和操作它的方法打包在一起，外部只能通过方法访问，不能直接碰内部数据。

### AF 与 RI

- **AF（Abstraction Function）**：`SessionContext._messages[0..n]` 代表一段按顺序排列的对话消息
- **RI（Representation Invariant）**：
  - 每条消息必须有 `role` 和 `content` 字段
  - `role` 只能是 `"user"`、`"assistant"`、`"system"` 之一
  - 消息总数不超过 100 条

### 实现

```python
class SessionContext:
    VALID_ROLES = {"assistant", "user", "system"}
    MAX_MESSAGES = 100

    def __init__(self, initial_messages=None):
        self._messages = []
        if initial_messages:
            for msg in initial_messages:
                self.add_message(msg)

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
        return copy.deepcopy(self._messages)  # 防御性拷贝

    def _check_rep(self):
        assert len(self._messages) <= self.MAX_MESSAGES
        for msg in self._messages:
            assert "role" in msg and "content" in msg
            assert msg["role"] in self.VALID_ROLES
```

**为什么用 `copy.deepcopy`？** 防止调用方拿到引用后修改内部状态，破坏封装性。

### 破坏性测试

```python
def test_invalid_role_is_rejected():
    ctx = SessionContext()
    with pytest.raises(ValueError):
        ctx.add_message({"role": "hacker", "content": "..."})

def test_get_messages_returns_copy():
    ctx = SessionContext()
    ctx.add_message({"role": "user", "content": "hello"})
    msgs = ctx.get_messages()
    msgs[0]["content"] = "tampered"
    assert ctx.get_messages()[0]["content"] == "hello"  # 内部未被修改
```

### 接入 agents.py

将 `agents.py` 中所有 `final_messages = []` 替换为 `ctx = SessionContext()`，`.append()` 替换为 `ctx.add_message()`，传给模型时用 `ctx.get_messages()`。

## 验证结果

```
event: message_chunk → "你好！我是一个乐于助人的AI助手..."
event: status        → "回答完成"
event: done          → [DONE]
```

完整链路验证通过：Provider 自动发现 ✓ 模型创建 ✓ 智能体创建 ✓ 流式对话正常 ✓
