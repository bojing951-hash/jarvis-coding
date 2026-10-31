// JARVIS 审批可行性实验代码（2026-11-01）
//
// 这不是生产实现，也不应被 jarvisctl 直接调用。
// 目的：验证「Secure Enclave 密钥 + 用户在场 + 不可导出 + 服务端可验签」
// 能否在当前 Mac 上、在没有 Apple Developer 签名身份的情况下成立。
//
// 构建：swiftc -O se-keytool.swift -o se-keytool
// 用法：
//   ./se-keytool gen <blob> <pub-raw> <presence|none>
//   ./se-keytool sign <blob> <payload> [reason]
//   ./se-keytool pub <blob>

import Foundation
import CryptoKit
import Security
import LocalAuthentication

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func makeAccessControl(presence: Bool) -> SecAccessControl {
    var error: Unmanaged<CFError>?
    var flags: SecAccessControlCreateFlags = [.privateKeyUsage]
    if presence { flags.insert(.userPresence) }
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        flags,
        &error
    ) else {
        fail("AC_FAIL \(String(describing: error?.takeRetainedValue()))")
    }
    return access
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("usage: gen <blob> <pub> <presence|none> | sign <blob> <payload> [reason] | pub <blob>")
}

switch args[1] {
case "gen":
    guard args.count >= 5 else { fail("gen args") }
    let presence = args[4] == "presence"
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: makeAccessControl(presence: presence))
        try key.dataRepresentation.write(to: URL(fileURLWithPath: args[2]), options: [.atomic])
        try key.publicKey.rawRepresentation.write(to: URL(fileURLWithPath: args[3]), options: [.atomic])
        print("GEN_OK presence=\(presence) blob=\(key.dataRepresentation.count) pub=\(key.publicKey.rawRepresentation.count)")
    } catch {
        fail("GEN_FAIL \(error)")
    }

case "sign":
    guard args.count >= 4 else { fail("sign args") }
    guard let blob = try? Data(contentsOf: URL(fileURLWithPath: args[2])) else { fail("cannot read blob") }
    guard let payload = try? Data(contentsOf: URL(fileURLWithPath: args[3])) else { fail("cannot read payload") }
    let reason = args.count >= 5 ? args[4] : "JARVIS 需要你确认一次高风险操作"
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
        print("SIGN_OK der=\(signature.derRepresentation.count) raw=\(signature.rawRepresentation.count) b64=\(signature.derRepresentation.base64EncodedString())")
    } catch {
        fail("SIGN_FAIL \(error)")
    }

case "pub":
    guard args.count >= 3 else { fail("pub args") }
    guard let blob = try? Data(contentsOf: URL(fileURLWithPath: args[2])) else { fail("cannot read blob") }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)
        print("PUB_OK raw=\(key.publicKey.rawRepresentation.count) b64=\(key.publicKey.rawRepresentation.base64EncodedString())")
    } catch {
        fail("PUB_FAIL \(error)")
    }

default:
    fail("unknown command")
}
