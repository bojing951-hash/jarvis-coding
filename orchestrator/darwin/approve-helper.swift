// JARVIS 审批助手（P0-SEC-01-FIX2 / DEF-04）
// 用 macOS LocalAuthentication 做真实用户在场认证。
// 该程序不持有任何密钥，只返回退出码：
//   0 = 用户已认证   1 = 用户拒绝   2 = 系统不支持   3 = 超时/无法确认
import Foundation
import LocalAuthentication

let reason = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "JARVIS 需要你确认一次高风险操作"

let timeoutSeconds = CommandLine.arguments.count > 2
    ? (Double(CommandLine.arguments[2]) ?? 60)
    : 60

let context = LAContext()
context.localizedCancelTitle = "拒绝"
context.localizedFallbackTitle = "使用密码"

var authError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
    FileHandle.standardError.write(
        "UNAVAILABLE: \(authError?.localizedDescription ?? "无法使用系统认证")\n".data(using: .utf8)!
    )
    exit(2)
}

var finished = false
var exitCode: Int32 = 3

context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
    if success {
        exitCode = 0
        FileHandle.standardOutput.write("AUTHORIZED\n".data(using: .utf8)!)
    } else {
        let ns = error as NSError?
        if let ns, ns.domain == LAError.errorDomain,
           ns.code == LAError.appCancel.rawValue || ns.code == LAError.userCancel.rawValue {
            exitCode = 1
            FileHandle.standardError.write("DENIED: user cancelled\n".data(using: .utf8)!)
        } else if let ns, ns.code == LAError.authenticationFailed.rawValue {
            exitCode = 1
            FileHandle.standardError.write("DENIED: authentication failed\n".data(using: .utf8)!)
        } else {
            exitCode = 3
            FileHandle.standardError.write(
                "UNCONFIRMED: \(error?.localizedDescription ?? "无法确认")\n".data(using: .utf8)!
            )
        }
    }
    finished = true
}

let deadline = Date().addingTimeInterval(timeoutSeconds)
while !finished && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
}

if !finished {
    FileHandle.standardError.write("UNCONFIRMED: timeout\n".data(using: .utf8)!)
    exit(3)
}
exit(exitCode)
