# macOS 审批技术可行性验证报告

> 工作包：JARVIS-ENG-GATE-01 / Task B  
> 结论：**AUTH_FEASIBLE**（已在当前真实 Mac 上验证可行路线；生产审批器尚未改写）  
> 验证日期：2026-11-01  
> 验证机器：macOS 15.6.1 (24G90) / Apple M4 / arm64  
> 固定基线：`3ad1150c3be3f3013c5e8fe3238305d2d7c3fcdc`  
> 说明：本报告只做可行性验证，不修改冻结契约，不把实验代码当作生产实现。

## 1. 结论摘要

1. `-34018` 的直接原因不是“错误码本身”，而是 **当前审批器以数据保护钥匙串（Data Protection Keychain）为目标，却没有 `com.apple.application-identifier`、`com.apple.security.application-groups` 或 `keychain-access-groups` entitlement**。`securityd` 的实际日志给出了该结论。
2. 当前机器上的 `jarvis-auth` 是 **ad-hoc / linker-signed**，`TeamIdentifier` 为空，实际 entitlement 为空；机器上 **0 个有效代码签名身份**。
3. 按 Apple TN3137，数据保护钥匙串的访问组必须来自代码签名 entitlement，而且这些 entitlement **必须由 provisioning profile 授权**，程序还需要可嵌入 profile 的 app-like bundle。当前 CLI 三者都没有，所以原实现无法生成生产密钥。
4. **已实测出一条不需要 Apple Developer 账号、不需要付费、可在当前 Mac 运行的最小可行路线**：
   - 使用 CryptoKit `SecureEnclave.P256.Signing.PrivateKey` 创建 **Secure Enclave P-256 密钥**（不写入钥匙串，使用 wrapped blob 持久化）；
   - 访问控制使用 `.userPresence` + `.privateKeyUsage`；
   - 持久化 427 字节的 SE wrapped key blob（不含原始私钥），公钥单独保存为 SPKI；
   - 签名时用 `LAContext` 加载 blob 并签名，系统真实弹出本地认证（Touch ID 或系统密码）；
   - 服务端用现有 `verifyApprovalSignature`（SPKI DER + SHA-256）独立验签。
5. 该路线已实测：密钥创建成功、私钥不可导出（`extractable=0`，导出返回 “export not implemented”）、真实本地认证（Touch ID 或系统密码；未记录具体方式）后签名成功、Node 独立验签成功、篡改载荷/错误公钥失败、禁止交互时无法静默签名。
6. **原 keychain 实现仍然失败，生产审批尚未修复**。本轮没有改写审批系统；推荐路线需要后续独立实现与验收。

## 2. 实际环境

| 项 | 实测值 |
|---|---|
| macOS | 15.6.1，Build 24G90 |
| CPU / 架构 | Apple M4 / arm64 |
| Secure Enclave | 支持（Apple Silicon；Apple 文档要求 M1 或更新，或带 Touch Bar/Touch ID 的 Mac） |
| Xcode Command Line Tools | `/Library/Developer/CommandLineTools` |
| Swift | Apple Swift 6.2（swiftlang-6.2.0.19.9） |
| Xcode.app | 未安装 |
| 有效代码签名身份 | `0 valid identities found` |
| 默认钥匙串 | `~/Library/Keychains/login.keychain-db`，no-timeout |
| Touch ID | 已配置；`bioutil -r` 显示 biometrics for unlock = 1 |
| LocalAuthentication | `deviceOwnerAuthentication=true`，`biometryType=1`（Touch ID） |

### 2.1 生产审批器的实际签名状态

安装路径：`~/.openclaw/jarvis/bin/jarvis-auth`（62,792 bytes，Mach-O arm64）

```text
Identifier=jarvis-auth
CodeDirectory v=20400 size=612 flags=0x20002(adhoc,linker-signed)
Signature=adhoc
TeamIdentifier=not set
```

`codesign -d --entitlements :-` 没有输出任何 entitlement plist。也就是说：

- 不是“签名身份配置错误”，而是 **根本没有签名身份**；
- 不是“entitlement 文件写错”，而是 **实际产物没有任何 entitlement**；
- 不能把源码里的意图当成构建产物的能力。

## 3. 原始错误与根因

### 3.1 复现

```bash
~/.openclaw/jarvis/bin/jarvis-auth keygen
```

输出：

```text
生成密钥失败: Optional(Error Domain=NSOSStatusErrorDomain Code=-34018
"failed to add key to keychain: <SecKeyRef curve type: kSecECCurveSecp256r1,
algorithm id: 3, key type: ECPrivateKey, version: 4, block size: 256 bits, ...>")
```

### 3.2 系统日志（关键证据）

```text
secd: ... add Error Domain=NSOSStatusErrorDomain Code=-34018
"Client has neither com.apple.application-identifier nor
com.apple.security.application-groups nor keychain-access-groups entitlements"
```

同一时段还可见 `SecItemAdd_ios`，说明该调用走的是数据保护钥匙串路径。

### 3.3 根因分解

| 可能原因 | 实测判断 |
|---|---|
| 签名身份缺失 | 是。`0 valid identities found`；产物 ad-hoc，TeamIdentifier 为空 |
| entitlement 配置错误 | 不是“配置错”，而是实际产物完全没有 entitlement |
| Keychain access group 配置错误 | 当前没有 access group 可用；数据保护钥匙串需要 entitlement + provisioning profile |
| Data Protection 与传统 Keychain 差异 | 是。原调用走 `SecItemAdd_ios`（数据保护路径）；显式改用 file-based keychain 后可创建密钥，但该密钥可导出，不满足要求 |
| Keychain API 使用错误 | 是。原实现使用 `SecKeyCreateRandomKey` + `kSecAttrAccessControl`，隐式目标为数据保护钥匙串；没有处理 CLI 无 entitlement 的事实 |
| 是否真的需要付费 Apple Developer | **不能由错误码直接推出**。需要的是 Apple 授权的 provisioning profile；付费会员是一条路径，但不是唯一路径。本轮找到的 CryptoKit SE 路线完全不需要账号 |

### 3.4 Apple 文档依据

Apple TN3137《On Mac keychain APIs and implementations》：

> macOS builds the list of data protection keychain access groups available to your program from its code signing entitlements. These entitlements must be authorized by a provisioning profile. Your program needs an app-like bundle structure in which to embed that profile.

同一文档还指出，以下能力需要数据保护钥匙串：

> Protecting an item with biometrics (Touch ID and Face ID).  
> Protecting a key with the Secure Enclave.

这解释了为什么“只把 `-34018` 当成购买会员的理由”是不充分的：问题是数据保护钥匙串的签名/授权链，而不是某个单一 API。

## 4. 验证方法与实验矩阵

所有实验均在临时目录 `/tmp/jarvis-auth-spike` 中进行；没有使用真实生产授权签名，没有记录用户密码或生物识别数据，没有购买任何订阅。

| 编号 | 实验 | 结果 | 判断 |
|---|---|---|---|
| E1 | 原审批器 `keygen`（无签名、无 entitlement） | `-34018` | 复现生产错误 |
| E2 | 显式 `kSecUseDataProtectionKeychain=false`（传统 keychain） | 密钥创建成功；`extr=1`；私钥 `SecKeyCopyExternalRepresentation` 返回 97 bytes | **拒绝**：私钥可导出 |
| E3 | SE 持久密钥（`kSecAttrIsPermanent=true`） | `-34018` | 持久化到 keychain 需要 entitlement |
| E4 | SE 密钥（`SecKeyCreateRandomKey` 不带 `kSecAttrIsPermanent`） | 仍 `-34018` | 该 API 仍尝试加入 keychain |
| E5 | CryptoKit `SecureEnclave.P256.Signing.PrivateKey()` | 成功，公钥 raw 64 bytes | SE 可用 |
| E6 | CryptoKit + `.userPresence` + `.privateKeyUsage` | 成功，blob 427 bytes | 可创建受用户在场保护的 SE 密钥 |
| E7 | 用 E6 blob 在独立进程签名 | 系统弹出本地认证（Touch ID 或系统密码）；认证后 `SIGN_OK`，DER 70 bytes | 用户在场被真实要求 |
| E8 | `LAContext.interactionNotAllowed=true` 下签名 | `LAError -1004 "User interaction is required."`，无签名 | 不能静默绕过 |
| E9 | Node `crypto.verify('sha256')` 独立验签 | `valid=true`；篡改载荷 `false`；错误公钥 `false` | 独立验证成立 |
| E10 | `SecKeyCreateWithData(blob)` + 导出 | token=`com.apple.setoken`，`extractable=0`，导出 `-4 export not implemented` | 私钥不可导出 |
| E11 | ad-hoc 签名 + `keychain-access-groups` entitlement | AMFI 直接 kill（exit 137）：`code has restricted entitlements, but validation failed` | ad-hoc 不能携带受限 entitlement |
| E12 | 无签名数据保护 generic password | `-34018` | 数据保护钥匙串整体需要 entitlement |
| E13 | 无签名 file-based generic password | `OSStatus=0` | 传统钥匙串不要求该 entitlement |
| E14 | 自签名证书导入 + codesign | 证书未被信任，`0 valid identities`，codesign 未找到身份，二进制仍为 ad-hoc | 未成立，不作为结论依据 |
| E15 | 复制二进制 + 同一 presence blob + 禁止交互 | `-1004` 拒绝 | ACL 随 blob，不因换二进制而绕过 |

服务端绑定与一次性挑战：本轮没有改服务端逻辑。现有 `FIX3-A` 6 项测试（合法签名、篡改、缺公钥、助手替换、重放、跨任务）本地 **6/6 通过**；真实 SE 签名使用同一 SHA-256 / SPKI / DER 方案，已验证与 `verifyApprovalSignature` 兼容。挑战只能消耗一次、挑战与任务绑定由服务端已有测试覆盖。

### 4.1 关键输出

```text
# E2 传统 keychain
LOAD_OK attrs:
  extr = 1
PRIVATE_EXPORT_OK bytes=97

# E5/E6 CryptoKit
CRYPTOKIT_SE_OK public=64
AC_INIT_OK blob=427

# E7 用户完成本地认证后
SIGN_OK der=70 raw=64 b64=MEQCIGxExBTN5vJrwsLVDUu32Q26t788QUfM2v87wjNeBJ9EAiBeOKTQHpkNq5OUwl3UAcSiYph8vzS5To2RuVUgdGfB8A==

# E9
{"valid":true,"tamperedValid":false,"wrongKeyValid":false,"sigBytes":70}

# E10
ATTR extractable=0 token=com.apple.setoken
EXPORT_FAIL ... Code=-4 "export not implemented for key ..."

# E11
AMFI: ... bailing out because of restricted entitlements.
Code has restricted entitlements, but the validation of its code signature failed.
```

LocalAuthentication 日志（摘录）：

```text
LAContext[...] evaluateAccessControl:<SecAccessControlRef:
aku;ock(cpo(DeviceOwnerAuthentication));odel(true);osgn(cpo(DeviceOwnerAuthentication));...>
operation:osgn ... returned { ... }
```

其中 `osgn` 表示签名操作，`DeviceOwnerAuthentication` 表示 Touch ID 或系统密码；这证明用户在场是操作系统/SE 层的要求，而不是仅靠应用代码检查。

## 5. 技术候选方案

### 方案 A：数据保护钥匙串 + Apple 授权的 provisioning profile

- 形式：继续使用 keychain / Secure Enclave 持久密钥，给 helper 套 app-like bundle，签名并嵌入 profile，entitlement 包含 `keychain-access-groups` / `application-identifier`。
- 优点：与 Apple 官方推荐的 DP keychain 模型一致；可把 key 绑定到签名身份/访问组。
- 现状：本机 0 个签名身份，无 Xcode.app，无 provisioning profile；ad-hoc 携带受限 entitlement 会被 AMFI kill。
- 成本：需要 Apple 账号与签名身份。Apple Developer Program 官方页面标价 **US$99/年**；免费 Apple 账号可用于注册，但“免费 personal team 能否为 macOS CLI/app 签发可用 profile”本轮**未验证**，不能断言必须付费。
- 结论：不是当前环境的最小可行路线；若未来要采用，需用户提供 Apple 账号/Xcode 并做一次真实签名实验。

### 方案 B：CryptoKit Secure Enclave 密钥 + wrapped blob（不依赖 keychain 持久化，推荐）

- 形式：`SecureEnclave.P256.Signing.PrivateKey(accessControl:)` 生成 SE 密钥；把 `dataRepresentation`（427 bytes）存为 0600 文件；公钥以 SPKI 保存；签名时用 `LAContext` 重建并签名。
- 优点：
  - 当前 Mac 实测可用，无需 Apple Developer 账号、无需付费；
  - 私钥在 Secure Enclave 内，实测不可导出；
  - `.userPresence` 由系统执行，真实本地认证（Touch ID 或系统密码）；
  - 服务端现有验签逻辑无需改变；
  - 不引入桌面应用或复杂基础设施。
- 代价/风险：blob 是“可请求签名的能力”，需要 0600 保护；不绑定代码签名身份；提示语由调用方控制；重启后持久性尚待专项验证。
- 结论：**推荐作为下一轮实现路线**。

### 方案 C：传统 keychain 软件密钥

- 实测可创建，但 `extr=1`，私钥可导出 97 bytes；还可出现 keychain 访问提示。
- 结论：**拒绝**。这是普通软件密钥，不满足“不可导出”的原要求，不得用来冒充原安全等级。

### 方案 D：FIDO2 / 外接硬件密钥

- 可提供硬件保护和用户触摸，但需要额外购买硬件、改动审批链路，当前无必要。
- 结论：备选，不推荐作为首选。

## 6. 推荐方案（方案 B）的最小实现轮廓

本轮**没有**改写生产审批系统；以下仅作为后续实现建议：

1. `keygen`：
   - 用 CryptoKit 创建 `SecureEnclave.P256.Signing.PrivateKey`，访问控制 `.userPresence` + `.privateKeyUsage`；
   - 把 `dataRepresentation` 写入 `~/.openclaw/jarvis/auth/approval.sekey`（0600）；
   - 把 SPKI 公钥写入 `~/.openclaw/jarvis/auth/pubkey.der`（现有服务端路径）。
2. `sign <payload-file> <reason>`：
   - 读取 blob；用 `LAContext`（localizedReason、cancel/fallback 文案）重建密钥；
   - 对 payload 做 SHA-256 ECDSA 签名，输出 DER base64；
   - 用户取消/失败时非零退出，服务端保持拒绝。
3. `pubkey`：
   - 读取已保存的 SPKI 公钥；不触发认证。
4. 服务端：
   - 保持 `buildApprovalPayload` / `verifyApprovalSignature` / `consumeAuthChallenge` 不变；
   - 审批载荷继续包含 `task_id`、`digest`、`nonce`、`expires_at`；
   - 一次性挑战与任务绑定逻辑不变。
5. 迁移：
   - 旧 keychain 密钥不存在（本机 keygen 从未成功），无需迁移；
   - 若未来存在旧密钥，明确停用并重新生成，不能静默降级。
6. 验证：
   - 单元测试覆盖签名/验签/篡改/错误公钥；
   - 真实本地认证手工验证（Touch ID 或系统密码）；
   - 真实审批 E2E（批准→执行→审计）在独立测试仓库完成；
   - 重启后 blob 可用性专项验证。

## 7. 是否需要用户提供额外条件

| 路线 | 需要用户提供 | 成本 |
|---|---|---|
| B（推荐） | 无账号/无购买；签名时由用户本人完成 Touch ID 或系统密码 | 0 |
| A（keychain + profile） | Apple 账号、Xcode/签名环境、provisioning profile；若要正式分发可能需 Developer Program | 官方标价 US$99/年；免费 personal team 的 macOS 能力未验证 |

本轮没有要求用户购买任何订阅，也没有降低安全要求。

## 8. 未解决风险与限制

1. **生产审批仍未修复**：当前 `jarvis-auth keygen` 仍返回 `-34018`；方案 B 只是验证过的候选路线，尚未合入生产代码。
2. **重启持久性未实测**：CryptoKit 的 `dataRepresentation` 设计用于重建密钥，但本报告没有做重启后签名实验；实现阶段必须补做。
3. **blob 是 bearer capability**：拿到 blob 的程序可以发起签名请求，但仍需用户在场；不能静默签名。blob 必须 0600，并纳入备份/权限审计。
4. **未绑定代码签名身份**：任何能读取 blob 的二进制都可以请求认证；服务端公钥固定 + 一次性挑战可阻止伪造审批，但不能阻止“诱导用户批准”的社会工程。提示语应展示任务信息，而不是只显示通用文案。
5. **跨机器未验证**：SE 密钥预期绑定本机 Secure Enclave；未在第二台 Mac 上验证，不能把“复制 blob 到别的机器可用”当作已排除风险。
6. **仅 Apple Silicon / T2 可用**：无 Secure Enclave 的 Intel Mac 需要另行评估 fallback；不得退回普通软件密钥。
7. **CI 不能替代真实认证**：Touch ID/系统密码无法在 GitHub Actions 中真实执行；生产验证必须在真实 Mac 上完成并留存证据。

## 9. 复现材料

- 实验代码：`docs/spikes/se-keytool.swift`（仅实验，不是生产实现）。
- 独立验签脚本：`docs/spikes/verify-se-signature.mjs`。
- 临时实验目录：`/tmp/jarvis-auth-spike`（本机临时目录，不进入仓库）。
- 关键实验命令（在临时目录执行）：

```bash
swiftc -O se-keytool.swift -o se-keytool
./se-keytool gen k-presence.blob k-presence.pub presence
./se-keytool sign k-presence.blob payload.bin "JARVIS 技术验证：..." > sig.txt
# 从 sig.txt 取出 b64= 后面的签名，写入 sig.b64
node verify-se-signature.mjs k-presence.pub payload.bin sig.b64
```

- 生产错误复现：

```bash
~/.openclaw/jarvis/bin/jarvis-auth keygen
```

## 10. 参考

- Apple TN3137: On Mac keychain APIs and implementations  
  https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains
- Apple: Protecting keys with the Secure Enclave  
  https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave
- Apple CryptoKit: `SecureEnclave.P256.Signing.PrivateKey`  
  https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing/privatekey
- Apple CryptoKit: `dataRepresentation`  
  https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing/privatekey/datarepresentation
- Apple CryptoKit: `init(dataRepresentation:authenticationContext:)`  
  https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing/privatekey/init(datarepresentation:authenticationcontext:)
- Apple Developer Program（US$99/年）  
  https://developer.apple.com/programs/

## 11. 最终判定

**AUTH_FEASIBLE**。

- 不是因为“买了会员就能解决”，而是因为找到并实测了一条当前环境可运行、满足不可导出密钥 + 真实用户在场 + 服务端独立验签的路线。
- 原 keychain 实现仍不可用；生产修复属于后续实现工作，不在本轮擅自改写。
- 本报告不构成生产验收通过，也不替代 Agent 2 的独立验收。
