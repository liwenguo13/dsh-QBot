# QBot C++ 重写计划

目标：把交易内核、Binance 现货 + 杠杆合约、LLM 路由、风控、状态和像素复古 GUI 全部迁移到 C++17。

## 当前阶段

- [x] `src/mini_json.hpp`：无第三方依赖的 JSON 解析与序列化
- [x] `Makefile`：g++ 直接编译，链接 OpenSSL 与 pthread
- [x] `--selftest`：JSON 自检
- [ ] HTTP/TLS 客户端（OpenSSL）
- [ ] Binance 现货 API：行情、账户、下单
- [ ] Binance USDⓈ-M 合约 API：行情、账户、杠杆、下单、持仓
- [ ] LLM API 路由：DeepSeek / OpenCode Go / OpenRouter / OpenAI / Ollama
- [ ] 风控：杠杆、仓位、日亏损、回撤、ATR、只减仓
- [ ] paper / testnet / live 三档执行
- [ ] 状态持久化与审计
- [ ] 像素复古 GUI（OpenCode 深色 + 8bit 点缀 + 中文）
- [ ] 与 Python 版功能对齐后，平滑替换

## 构建

```bash
cd cpp
make
./qbot_cpp --selftest
```

## 说明

Python 版目前仍是功能完整的参考实现和过渡客户端。C++ 版会逐模块替换，不会为了“看起来完成”而做假对接。
