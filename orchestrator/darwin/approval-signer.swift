// JARVIS 审批签名器（FIX3-CLOSE / B 方案）
//
// 私钥由 Secure Enclave 持有，不进入进程内存、不可导出；
// 持久化的是 427-byte 的 wrapped key blob（不是原始私钥）。
// 每次签名由 LocalAuthentication .userPresence 要求用户在场。
//
// 用法：
//   jarvis-auth keygen [--dir <dir>] [--force]
//   jarvis-auth sign <payload-file> [reason] [--key <blob>]
//   jarvis-auth pubkey [--key <blob>] [--pub <pubkey.der>]
//
// 默认目录：$HOME/.openclaw/jarvis/auth
// 默认文件：approval.sekey (0600), pubkey.der (SPKI DER)
import Foundation
import CryptoKit
import Security
import LocalAuthentication

let spkiPrefix = Data([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
    0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04
])

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

func homeDirectory() -> String {
    ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
}

func defaultAuthDirectory() -> String {
    (homeDirectory() as NSString).appendingPathComponent(".openclaw/jarvis/auth")
}

func ensureDirectory(_ path: String) throws {
    try FileManager.default.createDirectory(
        at: URL(fileURLWithPath: path),
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
}

func writePrivateFile(_ data: Data, to path: String) throws {
    try ensureDirectory((path as NSString).deletingLastPathComponent)
    try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
}

func writePublicFile(_ data: Data, to path: String) throws {
    try ensureDirectory((path as NSString).deletingLastPathComponent)
    try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path)
}

func requirePrivateFilePermissions(_ path: String) {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
          let number = attrs[.posixPermissions] as? NSNumber else {
        fail("无法读取密钥文件权限: \(path)")
    }
    if number.intValue & 0o077 != 0 {
        fail("密钥文件权限过宽（必须为 0600）: \(path)", code: 2)
    }
}

func publicKeySPKI(_ key: SecureEnclave.P256.Signing.PrivateKey) -> Data {
    spkiPrefix + key.publicKey.rawRepresentation
}

func makeAccessControl() -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.userPresence, .privateKeyUsage],
        &error
    ) else {
        fail("无法创建访问控制: \(String(describing: error?.takeRetainedValue()))")
    }
    return access
}

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail("usage: jarvis-auth keygen|sign|pubkey")
}
args.removeFirst()

func takeOption(_ name: String) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    let value = args[index + 1]
    args.removeSubrange(index...(index + 1))
    return value
}

let explicitDirectory = takeOption("--dir")
let explicitKey = takeOption("--key")
let explicitPub = takeOption("--pub")
let force = args.contains("--force")
args.removeAll { $0 == "--force" }

let directory = explicitDirectory ?? defaultAuthDirectory()
let keyPath = explicitKey ?? (directory as NSString).appendingPathComponent("approval.sekey")
let keyDirectory = (keyPath as NSString).deletingLastPathComponent
let pubPath = explicitPub ?? (keyDirectory as NSString).appendingPathComponent("pubkey.der")

switch command {
case "keygen":
    guard SecureEnclave.isAvailable else {
        fail("当前机器不支持 Secure Enclave，拒绝生成普通软件密钥")
    }
    if FileManager.default.fileExists(atPath: keyPath) && !force {
        fail("密钥已存在，拒绝覆盖: \(keyPath)（如确认轮换，使用 --force）")
    }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: makeAccessControl())
        try writePrivateFile(key.dataRepresentation, to: keyPath)
        let spki = publicKeySPKI(key)
        try writePublicFile(spki, to: pubPath)
        print(spki.base64EncodedString())
    } catch {
        fail("生成 Secure Enclave 密钥失败: \(error)")
    }

case "sign":
    guard let payloadPath = args.first else { fail("缺少 payload 文件") }
    let reason = args.count > 1 ? args[1] : "JARVIS 需要你确认一次高风险操作"
    requirePrivateFilePermissions(keyPath)
    guard let blob = try? Data(contentsOf: URL(fileURLWithPath: keyPath)) else {
        fail("无法读取 Secure Enclave 密钥 blob: \(keyPath)")
    }
    guard let payload = try? Data(contentsOf: URL(fileURLWithPath: payloadPath)) else {
        fail("无法读取 payload: \(payloadPath)")
    }
    let context = LAContext()
    context.localizedReason = reason
    context.localizedCancelTitle = "拒绝"
    context.localizedFallbackTitle = "使用密码"
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(
            dataRepresentation: blob,
            authenticationContext: context
        )
        let signature = try key.signature(for: payload)
        print(signature.derRepresentation.base64EncodedString())
    } catch {
        fail("签名失败（用户拒绝或认证不可用）: \(error)")
    }

case "pubkey":
    guard let der = try? Data(contentsOf: URL(fileURLWithPath: pubPath)) else {
        fail("无法读取公钥文件: \(pubPath)（请先运行 keygen）")
    }
    print(der.base64EncodedString())

default:
    fail("未知命令: \(command)")
}
