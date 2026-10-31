// JARVIS 审批签名器（FIX3-A）
// 私钥存放在登录钥匙串，访问控制要求「用户在场」（Touch ID / 密码），不可导出。
// 用法：
//   jarvis-auth keygen                 生成密钥对，输出 DER(SPKI) 公钥的 base64
//   jarvis-auth sign <payload-file>    用私钥签名文件内容的 SHA-256，输出 DER 签名 base64
//   jarvis-auth pubkey                 输出公钥 base64
import Foundation
import Security
import LocalAuthentication

let tag = "com.jarvis.approval.signing".data(using: .utf8)!

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func base64(_ d: Data) -> String { d.base64EncodedString() }

// P-256 SPKI 前缀
let spkiPrefix = Data([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
    0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
])

func loadPrivateKey(prompt: String) -> SecKey? {
    let ctx = LAContext()
    ctx.localizedReason = prompt
    let q: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: tag,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecReturnRef as String: true,
        kSecUseAuthenticationContext as String: ctx,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var item: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &item)
    if st != errSecSuccess { return nil }
    return (item as! SecKey)
}

func publicKeyB64(_ key: SecKey) -> String? {
    guard let pub = SecKeyCopyPublicKey(key),
          let ext = SecKeyCopyExternalRepresentation(pub, nil) as Data? else { return nil }
    return base64(spkiPrefix + ext)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("用法: jarvis-auth keygen|sign <file>|pubkey") }

switch args[1] {
case "keygen":
    var err: Unmanaged<CFError>?
    guard let ac = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, &err
    ) else { fail("无法创建访问控制") }

    let priv: [String: Any] = [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag,
        kSecAttrAccessControl as String: ac
    ]
    let attrs: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecPrivateKeyAttrs as String: priv
    ]
    guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &err) else {
        fail("生成密钥失败: \(err?.takeRetainedValue() as Error? as Any)")
    }
    guard let pub = publicKeyB64(key) else { fail("导出公钥失败") }
    print(pub)

case "sign":
    guard args.count >= 3 else { fail("缺少 payload 文件") }
    let path = args[2]
    guard let data = FileManager.default.contents(atPath: path) else { fail("无法读取 payload") }
    let prompt = args.count >= 4 ? args[3] : "JARVIS 需要你确认一次高风险操作"
    guard let key = loadPrivateKey(prompt: prompt) else { fail("无法加载签名密钥（可能需要用户在场认证）") }
    var err: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, &err) else {
        fail("签名失败: \(err?.takeRetainedValue() as Error? as Any)")
    }
    print(base64(sig as Data))

case "pubkey":
    let q: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: tag,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecReturnRef as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { fail("未找到密钥") }
    guard let pub = publicKeyB64(item as! SecKey) else { fail("导出公钥失败") }
    print(pub)

default:
    fail("未知子命令: \(args[1])")
}
