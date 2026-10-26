import Darwin
import Foundation
import Security

// 只读取本进程已连接 socket；任何请求内容、调用方 pid 或环境均不作为身份声明。
private enum VerificationFailure: Error { case denied }
private func deny() throws -> Never { throw VerificationFailure.denied }
private let flags = SecCSFlags(rawValue: kSecCSStrictValidate)

private func signingInfo(_ code: SecCode) throws -> NSDictionary {
    guard SecCodeCheckValidity(code, flags, nil) == errSecSuccess else { try deny() }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess,
          let staticCode else { try deny() }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let information else { try deny() }
    let value = information as NSDictionary
    guard let signatureFlags = value[kSecCodeInfoFlags] as? UInt32,
          signatureFlags & 0x0002 == 0 else { try deny() } // kSecCodeSignatureAdhoc (CSCommon.h)
    return value
}

private func processInfo(_ pid: pid_t) throws -> proc_bsdinfo {
    var information = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &information, size) == size,
          information.pbi_pid == UInt32(pid), information.pbi_uid == getuid() else { try deny() }
    return information
}

private func sameProcess(_ first: proc_bsdinfo, _ second: proc_bsdinfo) -> Bool {
    first.pbi_pid == second.pbi_pid && first.pbi_ppid == second.pbi_ppid &&
        first.pbi_start_tvsec == second.pbi_start_tvsec && first.pbi_start_tvusec == second.pbi_start_tvusec
}

private func isGuiMain(_ pid: pid_t) throws -> Bool {
    // KERN_PROCARGS2 含敏感环境：仅在内存判断两个解释器开关，绝不写日志或标准输出。
    var mib = [Int32(CTL_KERN), Int32(KERN_PROCARGS2), pid]
    var size = 0
    guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0,
          size > MemoryLayout<Int32>.size, size <= 4 * 1024 * 1024 else { try deny() }
    var bytes = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, u_int(mib.count), &bytes, &size, nil, 0) == 0 else { try deny() }
    bytes = Array(bytes.prefix(size))
    let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    guard argc > 0 && argc < 65536 else { try deny() }
    var cursor = MemoryLayout<Int32>.size
    func nextString() throws -> String {
        guard cursor < bytes.count, let end = bytes[cursor...].firstIndex(of: 0) else { try deny() }
        let value = String(decoding: bytes[cursor..<end], as: UTF8.self)
        cursor = end + 1
        return value
    }
    _ = try nextString() // executable path
    while cursor < bytes.count && bytes[cursor] == 0 { cursor += 1 }
    var arguments: [String] = []
    for _ in 0..<argc { arguments.append(try nextString()) }
    // 同一 Electron executable 可作为 Node 解释器。此候选不能充当可信 GUI 根。
    let interpreterOptions = ["--eval", "--print", "--require", "--import", "--inspect", "--inspect-brk", "--inspect-wait", "--remote-debugging-port", "--remote-debugging-pipe", "--js-flags", "--app"]
    if arguments.dropFirst().contains(where: { argument in
        // LaunchServices 的历史 GUI PSN 参数不是 Node 的 -p 表达式。
        if argument.range(of: "^-psn_[0-9]+_[0-9]+$", options: .regularExpression) != nil { return false }
        return ["-e", "-p", "-r"].contains(where: { argument.hasPrefix($0) && !argument.hasPrefix("--") }) ||
            interpreterOptions.contains(where: { argument == $0 || argument.hasPrefix($0 + "=") })
    }) {
        return false
    }
    while cursor < bytes.count && bytes[cursor] != 0 {
        let entry = try nextString()
        if entry.hasPrefix("ELECTRON_RUN_AS_NODE=") || entry.hasPrefix("NODE_OPTIONS=") || entry.hasPrefix("DYLD_INSERT_LIBRARIES=") {
            let value = entry.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            if value.count == 2 && !value[1].isEmpty { return false }
        }
    }
    return true
}

private func verifyPeerSocket(_ fd: Int32) throws -> Bool {
    // 本进程就是持有 TCC 的 SEA Helper；Team 锚点不再依赖外置子进程的自报结果。
    var selfCode: SecCode?
    guard SecCodeCopySelf(SecCSFlags(), &selfCode) == errSecSuccess, let selfCode else { try deny() }
    let selfInformation = try signingInfo(selfCode)
    let identifier = selfInformation[kSecCodeInfoIdentifier] as? String
    guard identifier == "dev.zcode.cua-helper" || identifier == "dev.zcode.cua-helper.dev" else { try deny() }
    guard let team = selfInformation[kSecCodeInfoTeamIdentifier] as? String,
          team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { try deny() }
    var requirement: SecRequirement?
    let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
    guard SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement) == errSecSuccess,
          let requirement else { try deny() }
    guard SecCodeCheckValidity(selfCode, flags, requirement) == errSecSuccess else { try deny() }

    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { try deny() }
    var peer: pid_t = 0
    var peerSize = socklen_t(MemoryLayout<pid_t>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer, &peerSize) == 0,
          peerSize == MemoryLayout<pid_t>.size, peer > 1 else { try deny() }

    var pid = peer
    var ancestors: [proc_bsdinfo] = []
    var seen = Set<pid_t>()
    var foundMain = false
    for _ in 0..<64 {
        guard pid > 1, seen.insert(pid).inserted else { try deny() }
        let before = try processInfo(pid)
        var code: SecCode?
        let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, flags, requirement) == errSecSuccess else { try deny() }
        let information = try signingInfo(code)
        guard information[kSecCodeInfoTeamIdentifier] as? String == team else { try deny() }
        let identifier = information[kSecCodeInfoIdentifier] as? String
        let trustedIdentifier = identifier == "dev.zcode.app" || identifier == "dev.zcode.app.preview"
        let main = trustedIdentifier ? try isGuiMain(pid) : false
        let after = try processInfo(pid)
        guard sameProcess(before, after) else { try deny() }
        ancestors.append(before)
        if main { foundMain = true; break }
        pid = pid_t(before.pbi_ppid)
    }
    guard foundMain else { try deny() }
    // PID 复用、退出或重挂父进程期间的结果不能被缓存为已验证身份。
    for ancestor in ancestors {
        guard sameProcess(ancestor, try processInfo(pid_t(ancestor.pbi_pid))) else { try deny() }
    }
    return true
}

@_cdecl("uwork_verify_peer")
public func uworkVerifyPeer(_ fd: Int32) -> Int32 {
    do { return try verifyPeerSocket(fd) ? 1 : 0 }
    catch { return 0 }
}
