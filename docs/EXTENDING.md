# 使用者扩展指南

## 1. 先理解默认行为

`npm start` 不连接预测市场，也不调用任何私有 API。`SyntheticProvider` 生成虚构盘口与报价，`strategy.mjs` 始终跳过。实现策略前应先运行测试，使用独立演示数据库。

## 2. 策略契约

输入为 `{ round, features, nowMs }`：

| 字段 | 类型 / 含义 |
| --- | --- |
| `round.roundId` | 回合唯一标识，不应包含账户标识 |
| `round.asset` | 资产名称 |
| `round.targetPrice` | 官方目标价的十进制字符串，不从现货自行替代 |
| `round.endTimeMs` | 结算时间的 Unix 毫秒 |
| `features.windows` | 3 / 10 / 30 / 60 秒窗口；注意 `coverageMs`，不足不代表完整窗口 |
| `features.sourceAgeMs` | 已观察到的行情源年龄；真实来源的时钟偏差需单独处理 |

只有你验证过的策略才应返回候选，例如以下是**契约形状，不是交易策略**：

```js
return {
  action: 'CANDIDATE',
  side: userSelectedSide,                // 'UP' 或 'DOWN'
  budgetWei: plannedTotalDebit,           // bigint，包含费用的计划总支出
  probabilityLower: calibratedLowerBound, // 十进制字符串，由你的模型提供
  minEdge: requiredNetEdge,               // 十进制字符串，由你的研究确定
};
```

框架不会自动补概率、放宽策略或将不合格仓位提高到某个最低金额。引擎中的默认 10% 限制是公开演示防误操作配置，与原始生产模型无关。

## 3. 接入预测市场数据

继承 `ProviderAdapter`，只实现 `books(request)` 和 `quote(request)`。自行使用官方接口，不接入未授权数据源，不绕过服务限制。本仓库只提供合成实现；不宣称现成支持某个平台的预测账户交易。

`books` 返回两个**独立来源**的规范化快照：

```js
{
  roundId, side, observedAtMs,
  bids: [{ price: '0.49', shares: '100' }], // 降序
  asks: [{ price: '0.50', shares: '100' }], // 升序
}
```

合成适配器复制同一个虚构盘口，仅用于测试，**不构成生产环境双源验证**。实际适配器应验证来源身份、序列号、协议版本和时钟；缺少任意来源必须拒绝。

`quote` 返回：

```js
{
  id, roundId, side,
  totalDebitWei, // bigint，总成本 = 购份成本 + feeWei
  feeWei,       // bigint，必须来自真实报价，不在模型硬编码费率
  sharesWei,    // bigint，按每份命中兑付 1 单位的二元合约约定
  averagePrice, // 十进制字符串，包含盘口冲击但不包含上面的独立 feeWei
  expireAtMs,   // Unix 毫秒
}
```

若平台字段语义不同，必须在适配器转换，不能把整数 wei 字符串直接交给 `units()` 当十进制货币解析；使用 `BigInt(rawWeiString)`。`averagePrice × shares` 与扣费前成本仅允许 1 wei 舍入误差。实际平台若仅提供低精度均价，需要显式设计可审计的舍入规则，不能悄悄放宽校验。

`effectiveCost = totalDebit / shares`，校验 `probabilityLower - effectiveCost >= minEdge`。不要重复扣除已体现在均价中的价格冲击。每个候选只请求一次实际金额报价；过期或金额不匹配就跳过。

## 4. 真实公共现货流（可选）

`connectPublicSpot` 是不需要密钥的公共现货成交流示例，没有被默认启动。它不是完整生产连接管理器：你需要实现重连退避、停机检测、序列监测、服务条款检查与时钟质量评估。现货价格不是预测合约的结算预言机价格。

## 5. 结算和账本

调用 `store.settle(roundId, label, flatRule)`，重复结算幂等。`FLAT` 必须传入明确的 `UP` / `DOWN` / `REFUND` 规则。该示例只支持命中每份兑付 1 单位的合约，不支持部分兑付、平台结算附加费或复杂取消规则。适配平台前先扩展测试。

## 6. 可选工程模块

- `PredictionHttpAgent` 提供 HTTPS keep-alive、短期 DNS 缓存与累计连接里程碑，TLS 校验未关闭。
- `TokenBucket` 的容量由调用方传入，应先扣除预留预算；支持等待上限和取消信号。
- 这些组件是可复用工具，默认合成模式不发网络请求，因此没有真实 RTT。
- `PaperEngine` 序列化整个执行链，避免共享资金竞争；并不是最高吞吐方案。要并行化必须设计原子资金预占、超时释放和恢复流程。

## 7. 明确未实现的部分

实盘签名与下单、账户授权、资金划转、Telegram 远程控制、训练服务、MySQL 镜像和生产部署编排均未包含。不要仅修改 `mode` 文本便声称支持实盘，也不要把演示里的纸盘成交当作 FOK 执行。
