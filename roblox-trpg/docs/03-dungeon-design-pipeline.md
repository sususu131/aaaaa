# 副本设计流水线（AI Web Search 规范）

> 核心原则：**AI Search 是"副本设计阶段"的必需工具，不是数据库初始化阶段的必需工具。**
> 数据库初始化只建表 + 预置副本基础资料；技能、物品、奖励一律在此流水线中产出并审核。

## 全流程

```
Roblox Experience（如 "把 DOORS 加入副本数据库"）
       ↓
Step 1-2  Web Search 收集真实资料
       ↓
Step 3    AI 分析玩法
       ↓
Step 4    设计 TRPG 技能 / 被动 / 主动 / 装备 / 副本奖励
       ↓
Step 5    标注官方机制与原创内容的边界
       ↓
游戏规则系统 / 人工审核（skills.status: draft → approved）
       ↓
写入数据库（只有 approved 内容可进入奖励池）
       ↓
玩家通关副本
       ↓
规则系统结算奖励 → 玩家获得技能
```

## Step 1–2：资料收集（必须联网搜索，禁止凭记忆臆造）

1. 搜索该 Experience 的**官方 Roblox 页面**。
2. 搜索可靠的 **Wiki / 官方资料 / 社区资料**。

## Step 3：玩法分析

对收集到的资料分析以下维度：

- 核心玩法
- 玩家目标
- 主要敌人
- 特殊机制
- 可获得能力
- 标志性物品
- 游戏中的特殊行为

## Step 4：设计产出

基于分析结果，设计与该 Experience **强相关**的：

- 技能（`skills`）
- 被动能力 / 主动能力 / 反应能力（`skill_type`）
- 装备 / 物品（`items`）
- 副本奖励（`dungeon_rewards`，一个副本可挂多个奖励）

## Step 5：来源边界标注（`source_type`）

| source_type | 含义 | 示例 |
|-------------|------|------|
| `official` | Roblox 原作中真实存在的机制/能力 | Doors 中确实存在的躲藏机制 |
| `inspired` | 受原作机制启发的 **TRPG 再创作** | Doors 真实机制是"听声音判断 Figure 位置" → 设计技能「听觉强化」：特定危险场景中一次骰子判定获知敌人方位 |
| `original` | 本 TRPG 完全原创 | 与任何体验机制无关的通用技能 |

**红线：不得把 `inspired`/`original` 内容描述成 Roblox 原作中存在的能力。**

## 数据写入规范

### skills（AI 产出 = draft，审核后 = approved）

```
name / description / source_dungeon_id
source_type: official | inspired | original
skill_type:  passive | active | reaction
rarity:      common | rare | epic | legendary
effect_data: JSON 机制参数（骰子判定、数值），由规则系统消费
status:      draft → approved（规则系统/人工确认）
```

产出示例（Doors 设计阶段）：

```
技能：危险预警
source_type：inspired
skill_type：passive
source_dungeon：Doors
```

### dungeon_rewards（一个副本多个奖励）

```
dungeon_id / reward_type(skill|item|currency|special) / reward_id
drop_rate / is_guaranteed / is_optional / condition_data(JSON)
status: draft → approved
```

 Doors 奖励池示例（未来设计产出，非当前数据）：

```
Doors
├── 危险预警        100%（is_guaranteed）
├── 骨架钥匙        15%
├── 十字架          5%
├── 特殊能力        2%
└── 金币            通用货币
```

## 治理铁律

1. **AI 搜索只发生在副本设计阶段**；数据库初始化/建表阶段不做技能臆造。
2. 技能设计由**游戏设计规则**决定，不是把搜索结果直接复制进数据库。
3. 所有 AI 产出先进入 `draft`，经**游戏规则系统/人工审核**改为 `approved` 后才能进入奖励池。
4. **最终奖励发放必须经过规则系统确认**；AI（GM/副本设计）**不得直接修改 `player_skills`** 等玩家数据表。
5. 未来实现"把 X 加入副本数据库"指令时，AI 自动执行 Step 1–5 并输出待审核草稿，而不是手工 SQL。
